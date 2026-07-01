import { existsSync } from "node:fs";
import { join } from "node:path";
import { runPytest } from "../pythonRunner.js";

export type CharacterizationOutcome = "characterized" | "test_not_created" | "test_fails_immediately" | "flaky";

export interface CharacterizationGateResult {
  outcome: CharacterizationOutcome;
  passed: boolean;
}

const ALL_PASSED = 0;
const TESTS_FAILED = 1;

export async function classifyCharacterizationOutcome(opts: {
  targetDir: string;
  venvDir: string;
  testRelPath: string;
}): Promise<CharacterizationGateResult> {
  const testFilePath = join(opts.targetDir, opts.testRelPath);
  if (!existsSync(testFilePath)) {
    return { outcome: "test_not_created", passed: false };
  }

  const firstRun = await runPytest(opts.venvDir, opts.targetDir, opts.testRelPath);
  const secondRun = await runPytest(opts.venvDir, opts.targetDir, opts.testRelPath);

  if (firstRun.exitCode === ALL_PASSED && secondRun.exitCode === ALL_PASSED) {
    return { outcome: "characterized", passed: true };
  }
  if (firstRun.exitCode === TESTS_FAILED && secondRun.exitCode === TESTS_FAILED) {
    return { outcome: "test_fails_immediately", passed: false };
  }
  return { outcome: "flaky", passed: false };
}
