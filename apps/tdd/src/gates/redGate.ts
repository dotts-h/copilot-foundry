import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { isMissingSymbolError } from "../runner/pythonRunner.js";
import type { TargetRunner } from "../runner/types.js";
import type { BaselineReport } from "../phases/baseline.js";
import { soundPaths } from "../soundPaths.js";
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

export { isMissingSymbolError as isMissingSymbolCollectionError };

export async function classifyRedOutcome(opts: {
  targetDir: string;
  runner: TargetRunner;
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
  const lint = opts.runner.lintRedTest(testSource);

  const firstRun = await opts.runner.runTests(opts.targetDir, opts.testRelPath);
  const secondRun = await opts.runner.runTests(opts.targetDir, opts.testRelPath);

  const firstClass = opts.runner.classifyRun(firstRun);
  const secondClass = opts.runner.classifyRun(secondRun);

  let outcome: RedOutcome;
  if (firstClass === "passed" && secondClass === "passed") {
    outcome = "already_green";
  } else if (firstClass === "failed" && secondClass === "failed") {
    outcome = "failed_as_expected";
  } else if (
    (firstClass === "passed" && secondClass === "failed") ||
    (firstClass === "failed" && secondClass === "passed")
  ) {
    outcome = "flaky";
  } else if (
    firstClass === "harness_error" &&
    secondClass === "harness_error" &&
    opts.runner.isMissingSymbolError(firstRun.raw, opts.functionName) &&
    opts.runner.isMissingSymbolError(secondRun.raw, opts.functionName)
  ) {
    outcome = "failed_as_expected";
  } else {
    outcome = "collection_error";
  }

  const { tests: currentResults } = await opts.runner.runTestsVerbose(opts.targetDir);
  const testPathKey = opts.runner.testPathKey(opts.testRelPath);
  const currentlyFailingPaths = new Set(
    currentResults
      .filter((t) => t.outcome === "failed" || t.outcome === "error")
      .map((t) => t.nodeId.split("::")[0]),
  );
  const baselinePassingPaths = soundPaths(opts.baseline.tests);
  const preexistingRegressionPaths = [...currentlyFailingPaths].filter(
    (path) => path !== testPathKey && baselinePassingPaths.has(path),
  );

  return {
    outcome,
    passed: outcome === "failed_as_expected" && lint.blocking.length === 0,
    lint,
    preexistingRegressionPaths,
  };
}
