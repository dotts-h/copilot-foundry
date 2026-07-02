import { dirname, join } from "node:path";
import { runCommand } from "./exec.js";
import { runPytest } from "./pythonRunner.js";
import { runPytestVerbose, type BaselineTestResult } from "./phases/baseline.js";
import { isMissingSymbolCollectionError } from "./gates/redGate.js";
import { lintRedTest, lintGoRedTest, type RedLintResult } from "./gates/redLinter.js";
import { goModulePath, goPathUnit, isGoMissingSymbolError, runGoTest, runGoTestVerbose } from "./goRunner.js";
import type { PlannedSlice } from "./phases/plan.js";
import type { Language } from "./types.js";

export type ScopedVerdict = "passed" | "tests_failed" | "infra_error";

export interface TestToolchain {
  language: Language;
  runScoped(cwd: string, targetRelPath?: string): Promise<{ verdict: ScopedVerdict; raw: string }>;
  runOnPaths(cwd: string, paths: string[]): Promise<{ passed: boolean; raw: string }>;
  runVerbose(cwd: string): Promise<{ tests: BaselineTestResult[]; raw: string }>;
  pathUnit(relPath: string): string; // the unit runVerbose nodeIds are keyed by
  isMissingSymbolError(raw: string, functionName: string): boolean;
  lintRedTest(source: string): RedLintResult;
  supportsMutationGate: boolean;
  supportsRefactor: boolean;
  buildRedPrompt(slice: PlannedSlice): string;
  planNouns: { repo: string; identifier: string };
}

function mapPytestExitCode(exitCode: number): ScopedVerdict {
  if (exitCode === 0) return "passed";
  if (exitCode === 1) return "tests_failed";
  return "infra_error";
}

function buildPythonRedPrompt(slice: PlannedSlice): string {
  return (
    `Write ONLY a failing pytest test at ${slice.testRelPath} for this behavior: ${slice.description}. ` +
    `The implementation lives at ${slice.implRelPath} and does not yet satisfy this behavior. ` +
    "Include at least two assertions with different, non-trivially-related expected values (not just one " +
    "example) so the test actually triangulates the behavior and cannot be satisfied by a function that " +
    "always returns a single constant. " +
    "If the function or symbol under test does not exist yet in the implementation module, do NOT add it " +
    "to a module-top import -- import it inside the new test function(s) instead, so the rest of the test " +
    "module still collects and runs. Never modify or remove existing imports. " +
    "Do NOT implement or modify the implementation file. Do not create or modify any other file."
  );
}

function buildGoRedPrompt(slice: PlannedSlice): string {
  return (
    `Write ONLY a failing Go test at ${slice.testRelPath} using the standard \`testing\` package, in the SAME ` +
    `package as ${slice.implRelPath}, for this behavior: ${slice.description}. Include at least two assertions ` +
    "(t.Errorf/t.Fatalf) with different, non-trivially-related expected values so the test triangulates and " +
    "cannot be satisfied by a constant. If the function or symbol under test does not exist yet, reference it " +
    "anyway -- the resulting compile error IS the expected first RED; do NOT create or modify the implementation " +
    "file. Do not create or modify any other file."
  );
}

async function runPytestOnPaths(venvDir: string, cwd: string, paths: string[]): Promise<{ passed: boolean; raw: string }> {
  const pytestBin = join(venvDir, "bin", "pytest");
  const args = ["-q", "-o", "addopts=", ...(paths.length > 0 ? paths : ["."])];
  const result = await runCommand(pytestBin, args, {
    cwd,
    env: { PYTHONDONTWRITEBYTECODE: "1" },
    timeoutMs: 60_000,
  });
  return { passed: result.exitCode === 0, raw: result.stdout + result.stderr };
}

function pythonToolchain(venvDir: string): TestToolchain {
  return {
    language: "python",
    async runScoped(cwd, targetRelPath) {
      const result = await runPytest(venvDir, cwd, targetRelPath);
      return { verdict: mapPytestExitCode(result.exitCode), raw: result.raw };
    },
    async runOnPaths(cwd, paths) {
      return runPytestOnPaths(venvDir, cwd, paths);
    },
    async runVerbose(cwd) {
      const { tests, raw } = await runPytestVerbose(venvDir, cwd);
      return { tests, raw };
    },
    pathUnit(relPath) {
      return relPath;
    },
    isMissingSymbolError: isMissingSymbolCollectionError,
    lintRedTest,
    supportsMutationGate: true,
    supportsRefactor: true,
    buildRedPrompt: buildPythonRedPrompt,
    planNouns: { repo: "Python", identifier: "Python function (a valid Python identifier)" },
  };
}

async function runGoOnPaths(cwd: string, paths: string[]): Promise<{ passed: boolean; raw: string }> {
  if (paths.length === 0) {
    const { verdict, raw } = await runGoTest(cwd);
    return { passed: verdict === "passed", raw };
  }

  const seenDirs = new Set<string>();
  let passed = true;
  let raw = "";
  for (const path of paths) {
    const dir = dirname(path);
    if (seenDirs.has(dir)) continue;
    seenDirs.add(dir);
    const result = await runGoTest(cwd, path);
    raw += result.raw;
    if (result.verdict !== "passed") passed = false;
  }
  return { passed, raw };
}

function goToolchain(modulePath: string): TestToolchain {
  return {
    language: "go",
    async runScoped(cwd, targetRelPath) {
      return runGoTest(cwd, targetRelPath);
    },
    async runOnPaths(cwd, paths) {
      return runGoOnPaths(cwd, paths);
    },
    async runVerbose(cwd) {
      return runGoTestVerbose(cwd);
    },
    pathUnit(relPath) {
      return goPathUnit(modulePath, relPath);
    },
    isMissingSymbolError: isGoMissingSymbolError,
    lintRedTest: lintGoRedTest,
    supportsMutationGate: false,
    supportsRefactor: false,
    buildRedPrompt: buildGoRedPrompt,
    planNouns: { repo: "Go", identifier: "Go function (a valid Go identifier, exported or unexported)" },
  };
}

export async function createToolchain(
  language: Language,
  venvDir: string | undefined,
  workDir: string,
): Promise<TestToolchain> {
  if (language === "python") {
    if (venvDir === undefined) {
      throw new Error('createToolchain: language "python" requires venvDir');
    }
    return pythonToolchain(venvDir);
  }
  const modulePath = await goModulePath(workDir);
  return goToolchain(modulePath);
}
