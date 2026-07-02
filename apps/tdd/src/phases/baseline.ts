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

export async function runPytestVerbose(
  venvDir: string,
  cwd: string,
): Promise<{ exitCode: number; tests: BaselineTestResult[] }> {
  const pytestBin = join(venvDir, "bin", "pytest");
  const result = await runCommand(pytestBin, ["-o", "addopts=", "--tb=no", "-v"], {
    cwd,
    env: { PYTHONDONTWRITEBYTECODE: "1" },
    timeoutMs: 60_000,
  });

  if (result.exitCode === NO_TESTS_COLLECTED) {
    return { exitCode: result.exitCode, tests: [] };
  }

  return { exitCode: result.exitCode, tests: parsePytestVerboseOutput(result.stdout) };
}

export async function runBaseline(venvDir: string, targetDir: string): Promise<BaselineReport> {
  const { tests } = await runPytestVerbose(venvDir, targetDir);
  return { tests };
}
