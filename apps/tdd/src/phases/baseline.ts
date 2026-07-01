import { join } from "node:path";
import { runCommand } from "../exec.js";

export type TestOutcome = "passed" | "failed" | "error" | "skipped";

export interface BaselineTestResult {
  nodeId: string;
  outcome: TestOutcome;
}

export interface BaselineReport {
  tests: BaselineTestResult[];
}

const NO_TESTS_COLLECTED = 5;

const OUTCOME_MARKERS: Record<string, TestOutcome> = {
  PASSED: "passed",
  FAILED: "failed",
  ERROR: "error",
  SKIPPED: "skipped",
};

export function parsePytestVerboseOutput(raw: string): BaselineTestResult[] {
  const results: BaselineTestResult[] = [];
  const lineRegex = /^(\S+::\S+)\s+(PASSED|FAILED|ERROR|SKIPPED)\b/gm;
  let match: RegExpExecArray | null;
  while ((match = lineRegex.exec(raw)) !== null) {
    results.push({ nodeId: match[1], outcome: OUTCOME_MARKERS[match[2]] });
  }
  return results;
}

export async function runBaseline(venvDir: string, targetDir: string): Promise<BaselineReport> {
  const pytestBin = join(venvDir, "bin", "pytest");
  const result = await runCommand(pytestBin, ["--tb=no", "-v"], { cwd: targetDir });

  if (result.exitCode === NO_TESTS_COLLECTED) {
    return { tests: [] };
  }

  return { tests: parsePytestVerboseOutput(result.stdout) };
}
