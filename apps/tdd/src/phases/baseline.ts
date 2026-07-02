import type { TargetRunner } from "../runner/types.js";

export type TestOutcome = "passed" | "failed" | "error" | "skipped";

export interface BaselineTestResult {
  nodeId: string;
  outcome: TestOutcome;
}

export interface BaselineReport {
  tests: BaselineTestResult[];
}

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

export async function runBaseline(runner: TargetRunner, targetDir: string): Promise<BaselineReport> {
  const { tests } = await runner.runTestsVerbose(targetDir);
  return { tests };
}
