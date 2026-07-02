import { existsSync } from "node:fs";
import { join } from "node:path";
import type { TargetRunner } from "../runner/types.js";

export type CharacterizationOutcome = "characterized" | "test_not_created" | "test_fails_immediately" | "flaky";

export interface CharacterizationGateResult {
  outcome: CharacterizationOutcome;
  passed: boolean;
}

export async function classifyCharacterizationOutcome(opts: {
  targetDir: string;
  runner: TargetRunner;
  testRelPath: string;
}): Promise<CharacterizationGateResult> {
  const testFilePath = join(opts.targetDir, opts.testRelPath);
  if (!existsSync(testFilePath)) {
    return { outcome: "test_not_created", passed: false };
  }

  const firstRun = await opts.runner.runTests(opts.targetDir, opts.testRelPath);
  const secondRun = await opts.runner.runTests(opts.targetDir, opts.testRelPath);

  if (opts.runner.classifyRun(firstRun) === "passed" && opts.runner.classifyRun(secondRun) === "passed") {
    return { outcome: "characterized", passed: true };
  }
  if (opts.runner.classifyRun(firstRun) === "failed" && opts.runner.classifyRun(secondRun) === "failed") {
    return { outcome: "test_fails_immediately", passed: false };
  }
  return { outcome: "flaky", passed: false };
}
