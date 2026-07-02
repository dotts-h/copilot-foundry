import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { BaselineReport } from "../phases/baseline.js";
import type { TestToolchain } from "../toolchain.js";
import type { RedLintResult } from "./redLinter.js";

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
  toolchain: TestToolchain;
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
  const lint = opts.toolchain.lintRedTest(testSource);

  const firstRun = await opts.toolchain.runScoped(opts.targetDir, opts.testRelPath);
  const secondRun = await opts.toolchain.runScoped(opts.targetDir, opts.testRelPath);

  let outcome: RedOutcome;
  if (firstRun.verdict === "passed" && secondRun.verdict === "passed") {
    outcome = "already_green";
  } else if (firstRun.verdict === "tests_failed" && secondRun.verdict === "tests_failed") {
    outcome = "failed_as_expected";
  } else if (firstRun.verdict !== "infra_error" && secondRun.verdict !== "infra_error") {
    outcome = "flaky";
  } else if (
    firstRun.verdict === "infra_error" &&
    secondRun.verdict === "infra_error" &&
    opts.toolchain.isMissingSymbolError(firstRun.raw, opts.functionName) &&
    opts.toolchain.isMissingSymbolError(secondRun.raw, opts.functionName)
  ) {
    outcome = "failed_as_expected";
  } else {
    outcome = "collection_error";
  }

  const { tests: currentResults } = await opts.toolchain.runVerbose(opts.targetDir);
  const currentlyFailingPaths = new Set(
    currentResults
      .filter((t) => t.outcome === "failed" || t.outcome === "error")
      .map((t) => t.nodeId.split("::")[0]),
  );
  const baselinePassingPaths = new Set(
    opts.baseline.tests.filter((t) => t.outcome === "passed").map((t) => t.nodeId.split("::")[0]),
  );
  const preexistingRegressionPaths = [...currentlyFailingPaths].filter(
    (path) => path !== opts.toolchain.pathUnit(opts.testRelPath) && baselinePassingPaths.has(path),
  );

  return {
    outcome,
    passed: outcome === "failed_as_expected" && lint.blocking.length === 0,
    lint,
    preexistingRegressionPaths,
  };
}
