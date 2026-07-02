import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { runPytest } from "../pythonRunner.js";
import { runPytestVerbose, type BaselineReport } from "../phases/baseline.js";
import { lintRedTest, type RedLintResult } from "./redLinter.js";

export type RedOutcome =
  | "failed_as_expected"
  | "already_green"
  | "flaky"
  | "collection_error"
  | "missing_test_file";

export interface RedGateResult {
  outcome: RedOutcome;
  passed: boolean;
  lint: RedLintResult;
  preexistingRegressionPaths: string[];
}

const ALL_PASSED = 0;
const TESTS_FAILED = 1;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// A new symbol not yet existing in the implementation module is the canonical first RED of TDD --
// distinguish that from a trash/broken test so it doesn't get misclassified as a collection_error.
export function isMissingSymbolCollectionError(raw: string, functionName: string): boolean {
  const name = escapeRegExp(functionName);
  const patterns = [
    new RegExp(`cannot import name '${name}'`),
    new RegExp(`has no attribute '${name}'`),
    new RegExp(`NameError: name '${name}'`),
  ];
  return patterns.some((pattern) => pattern.test(raw));
}

export async function classifyRedOutcome(opts: {
  targetDir: string;
  venvDir: string;
  testRelPath: string;
  functionName: string;
  baseline: BaselineReport;
}): Promise<RedGateResult> {
  const testFilePath = join(opts.targetDir, opts.testRelPath);

  if (!existsSync(testFilePath)) {
    return {
      outcome: "missing_test_file",
      passed: false,
      lint: { blocking: ["test file was not created"], warnings: [] },
      preexistingRegressionPaths: [],
    };
  }

  const testSource = await readFile(testFilePath, "utf8");
  const lint = lintRedTest(testSource);

  const firstRun = await runPytest(opts.venvDir, opts.targetDir, opts.testRelPath);
  const secondRun = await runPytest(opts.venvDir, opts.targetDir, opts.testRelPath);

  let outcome: RedOutcome;
  if (firstRun.exitCode === ALL_PASSED && secondRun.exitCode === ALL_PASSED) {
    outcome = "already_green";
  } else if (firstRun.exitCode === TESTS_FAILED && secondRun.exitCode === TESTS_FAILED) {
    outcome = "failed_as_expected";
  } else if (
    [ALL_PASSED, TESTS_FAILED].includes(firstRun.exitCode) &&
    [ALL_PASSED, TESTS_FAILED].includes(secondRun.exitCode)
  ) {
    outcome = "flaky";
  } else if (
    ![ALL_PASSED, TESTS_FAILED].includes(firstRun.exitCode) &&
    ![ALL_PASSED, TESTS_FAILED].includes(secondRun.exitCode) &&
    isMissingSymbolCollectionError(firstRun.raw, opts.functionName) &&
    isMissingSymbolCollectionError(secondRun.raw, opts.functionName)
  ) {
    outcome = "failed_as_expected";
  } else {
    outcome = "collection_error";
  }

  const { tests: currentResults } = await runPytestVerbose(opts.venvDir, opts.targetDir);
  const currentlyFailingPaths = new Set(
    currentResults
      .filter((t) => t.outcome === "failed" || t.outcome === "error")
      .map((t) => t.nodeId.split("::")[0]),
  );
  const baselinePassingPaths = new Set(
    opts.baseline.tests.filter((t) => t.outcome === "passed").map((t) => t.nodeId.split("::")[0]),
  );
  const preexistingRegressionPaths = [...currentlyFailingPaths].filter(
    (path) => path !== opts.testRelPath && baselinePassingPaths.has(path),
  );

  return {
    outcome,
    passed: outcome === "failed_as_expected" && lint.blocking.length === 0,
    lint,
    preexistingRegressionPaths,
  };
}
