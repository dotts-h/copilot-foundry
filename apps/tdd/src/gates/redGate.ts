import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { runCommand } from "../exec.js";
import { runPytest } from "../pythonRunner.js";
import { parsePytestVerboseOutput, type BaselineReport } from "../phases/baseline.js";
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

export async function classifyRedOutcome(opts: {
  targetDir: string;
  venvDir: string;
  testRelPath: string;
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
  } else {
    outcome = "collection_error";
  }

  const pytestBin = join(opts.venvDir, "bin", "pytest");
  const fullRun = await runCommand(pytestBin, ["--tb=no", "-v"], { cwd: opts.targetDir });
  const currentResults = parsePytestVerboseOutput(fullRun.stdout);
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
