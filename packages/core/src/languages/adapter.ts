import { join } from "node:path";
import { runCommand } from "../exec.js";

export interface TestRunResult {
  exitCode: number;
  raw: string;
}

export interface VerboseTestResult {
  nodeId: string;
  outcome: "passed" | "failed" | "error" | "skipped";
}

export interface VerboseTestRunResult {
  exitCode: number;
  tests: VerboseTestResult[];
}

export interface LanguageAdapter {
  readonly name: string;
  runTests(cwd: string, testRelPath?: string): Promise<TestRunResult>;
  runTestsVerbose(cwd: string): Promise<VerboseTestRunResult>;
}

const PYTEST_NO_TESTS_COLLECTED = 5;

const PYTEST_OUTCOME_MARKERS: Record<string, VerboseTestResult["outcome"]> = {
  PASSED: "passed",
  FAILED: "failed",
  ERROR: "error",
  SKIPPED: "skipped",
};

function parsePytestVerbose(raw: string): VerboseTestResult[] {
  const results: VerboseTestResult[] = [];
  const lineRegex = /^(\S+::\S+)\s+(PASSED|FAILED|ERROR|SKIPPED)\b/gm;
  let match: RegExpExecArray | null;
  while ((match = lineRegex.exec(raw)) !== null) {
    results.push({ nodeId: match[1], outcome: PYTEST_OUTCOME_MARKERS[match[2]] });
  }
  return results;
}

export class PythonAdapter implements LanguageAdapter {
  readonly name = "python";

  constructor(private readonly venvDir: string) {}

  async runTests(cwd: string, testRelPath?: string): Promise<TestRunResult> {
    const pytestBin = join(this.venvDir, "bin", "pytest");
    const result = await runCommand(pytestBin, ["-q", testRelPath ?? "."], {
      cwd,
      env: { PYTHONDONTWRITEBYTECODE: "1" },
      timeoutMs: 60_000,
    });
    return { exitCode: result.exitCode, raw: result.stdout + result.stderr };
  }

  async runTestsVerbose(cwd: string): Promise<VerboseTestRunResult> {
    const pytestBin = join(this.venvDir, "bin", "pytest");
    const result = await runCommand(pytestBin, ["--tb=no", "-v"], {
      cwd,
      env: { PYTHONDONTWRITEBYTECODE: "1" },
      timeoutMs: 60_000,
    });
    if (result.exitCode === PYTEST_NO_TESTS_COLLECTED) {
      return { exitCode: result.exitCode, tests: [] };
    }
    return { exitCode: result.exitCode, tests: parsePytestVerbose(result.stdout) };
  }
}

function parseTapOutput(raw: string): VerboseTestResult[] {
  const results: VerboseTestResult[] = [];
  const lineRegex = /^(ok|not ok)\s+\d+\s+-\s+(.+)$/gm;
  let match: RegExpExecArray | null;
  while ((match = lineRegex.exec(raw)) !== null) {
    results.push({ nodeId: match[2].trim(), outcome: match[1] === "ok" ? "passed" : "failed" });
  }
  return results;
}

export class JavaScriptAdapter implements LanguageAdapter {
  readonly name = "javascript";

  async runTests(cwd: string, testRelPath?: string): Promise<TestRunResult> {
    const args = ["--test", ...(testRelPath ? [testRelPath] : [])];
    const result = await runCommand("node", args, { cwd, timeoutMs: 60_000 });
    return { exitCode: result.exitCode, raw: result.stdout + result.stderr };
  }

  async runTestsVerbose(cwd: string): Promise<VerboseTestRunResult> {
    const result = await runCommand("node", ["--test", "--test-reporter=tap"], { cwd, timeoutMs: 60_000 });
    return { exitCode: result.exitCode, tests: parseTapOutput(result.stdout) };
  }
}
