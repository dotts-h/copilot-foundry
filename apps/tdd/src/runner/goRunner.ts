import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { BaselineTestResult } from "../phases/baseline.js";
import { runCommand } from "../exec.js";
import type { FileSymbols } from "../phases/map.js";
import { computeGoMutationScore } from "./goMutation.js";
import { extractGoSymbols } from "./goSymbols.js";
import type { RunClassification, StaticGateResult, TargetRunner, TestRunResult } from "./types.js";

export const GO_RED_PROMPT_RULES =
  "Reference the new symbol directly in your test as if it already exists. " +
  "In Go a missing symbol makes the package fail to COMPILE — that compile failure " +
  "(`undefined: <symbol>`) IS the expected first RED. Do NOT stub or declare the symbol " +
  "yourself, and do not use reflection tricks to avoid the compile error.";

export const GO_MISSING_SYMBOL_RED_NOTE =
  "does NOT exist yet — your test will fail to compile with " +
  "`undefined: <symbol>`; that compile failure is the expected RED, do not stub the symbol.";

const EXCLUDED_PATH_SEGMENTS = ["vendor", "testdata"];

/** Test seam for mocking subprocess execution. */
export const goRunnerDeps = { runCommand };

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function packageOf(relPath: string): string {
  const dir = dirname(relPath);
  return dir === "." ? "./" : `./${dir}`;
}

export function testPathKeyFromRelPath(relPath: string): string {
  const dir = dirname(relPath);
  return dir === "." ? "." : dir;
}

export function pkgRelDirFromImportPath(importPath: string, modulePath: string): string {
  if (importPath === modulePath) return ".";
  const prefix = `${modulePath}/`;
  if (importPath.startsWith(prefix)) {
    return importPath.slice(prefix.length);
  }
  return importPath;
}

export function parseModulePath(goModContent: string): string {
  const match = /^module\s+(\S+)/m.exec(goModContent);
  return match?.[1] ?? "";
}

export function parseGoTestVerboseOutput(raw: string, modulePath: string): BaselineTestResult[] {
  const lines = raw.split("\n");
  const pendingTests: { lineIndex: number; name: string; outcome: BaselineTestResult["outcome"] }[] = [];
  const summaryLines: { lineIndex: number; importPath: string }[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const testMatch = /^--- (PASS|FAIL|SKIP): (.+?) \(/.exec(line);
    if (testMatch) {
      const outcome =
        testMatch[1] === "PASS" ? "passed" : testMatch[1] === "FAIL" ? "failed" : "skipped";
      pendingTests.push({ lineIndex: i, name: testMatch[2], outcome });
      continue;
    }

    const okMatch = /^ok\s+(\S+)/.exec(line);
    if (okMatch) {
      summaryLines.push({ lineIndex: i, importPath: okMatch[1] });
      continue;
    }

    const failMatch = /^FAIL\s+(\S+)/.exec(line);
    if (failMatch && !failMatch[1].startsWith("[") && failMatch[1] !== "FAIL") {
      summaryLines.push({ lineIndex: i, importPath: failMatch[1] });
    }
  }

  const results: BaselineTestResult[] = [];
  for (const test of pendingTests) {
    const summary = summaryLines.find((entry) => entry.lineIndex > test.lineIndex);
    if (!summary) continue;
    const pkgRelDir = pkgRelDirFromImportPath(summary.importPath, modulePath);
    results.push({ nodeId: `${pkgRelDir}::${test.name}`, outcome: test.outcome });
  }

  return results;
}

export function classifyGoRun(result: TestRunResult): RunClassification {
  if (result.exitCode === 0) return "passed";
  if (
    result.raw.includes("[build failed]") ||
    result.raw.includes("[setup failed]") ||
    /^# /m.test(result.raw)
  ) {
    return "harness_error";
  }
  if (result.exitCode === 1) return "failed";
  return "harness_error";
}

export function isMissingSymbolError(raw: string, functionName: string): boolean {
  const name = escapeRegExp(functionName);
  const patterns = [
    new RegExp(`undefined: (\\w+\\.)?${name}\\b`),
    new RegExp(`${name} not declared by package`),
    new RegExp(`has no field or method ${name}`),
  ];
  return patterns.some((pattern) => pattern.test(raw));
}

function goTestEnv(): Record<string, string> {
  return { GOFLAGS: "-count=1" };
}

async function readModulePathFromWorkDir(workDir: string): Promise<string> {
  try {
    const content = await readFile(join(workDir, "go.mod"), "utf8");
    return parseModulePath(content);
  } catch {
    return "";
  }
}

export function createGoRunner(_targetDir: string): TargetRunner {
  async function runTests(workDir: string, targetRelPath?: string): Promise<TestRunResult> {
    const pkg = targetRelPath !== undefined ? packageOf(targetRelPath) : "./...";
    const result = await goRunnerDeps.runCommand("go", ["test", pkg], {
      cwd: workDir,
      env: goTestEnv(),
      timeoutMs: 180_000,
    });
    return { exitCode: result.exitCode, raw: result.stdout + result.stderr };
  }

  async function runTestsOnPaths(workDir: string, paths: string[]): Promise<TestRunResult> {
    const pkgs =
      paths.length === 0
        ? ["./..."]
        : [...new Set(paths.map((p) => packageOf(p)))];
    const result = await goRunnerDeps.runCommand("go", ["test", ...pkgs], {
      cwd: workDir,
      env: goTestEnv(),
      timeoutMs: 180_000,
    });
    return { exitCode: result.exitCode, raw: result.stdout + result.stderr };
  }

  async function runTestsVerbose(workDir: string): Promise<{ exitCode: number; tests: BaselineTestResult[] }> {
    const result = await goRunnerDeps.runCommand("go", ["test", "./...", "-v"], {
      cwd: workDir,
      env: goTestEnv(),
      timeoutMs: 180_000,
    });
    const modulePath = await readModulePathFromWorkDir(workDir);
    return {
      exitCode: result.exitCode,
      tests: parseGoTestVerboseOutput(result.stdout + result.stderr, modulePath),
    };
  }

  function isSourceFile(relPath: string): boolean {
    const segments = relPath.split("/");
    if (segments.some((seg) => EXCLUDED_PATH_SEGMENTS.includes(seg))) return false;
    return relPath.endsWith(".go");
  }

  function isTestFile(relPath: string): boolean {
    return relPath.endsWith("_test.go");
  }

  async function extractSymbols(targetDir: string, files: string[]): Promise<Record<string, FileSymbols>> {
    return extractGoSymbols(targetDir, files);
  }

  async function runStaticGates(workDir: string): Promise<StaticGateResult[]> {
    const result = await goRunnerDeps.runCommand("go", ["vet", "./..."], {
      cwd: workDir,
      timeoutMs: 120_000,
    });
    return [
      {
        name: "go vet",
        passed: result.exitCode === 0,
        raw: result.stdout + result.stderr,
      },
    ];
  }

  return {
    language: "go",
    testFrameworkName: "go test",
    redPromptRules: GO_RED_PROMPT_RULES,
    missingSymbolRedNote: GO_MISSING_SYMBOL_RED_NOTE,

    async ensureEnv(_workDir: string): Promise<void> {},

    runTests,
    runTestsOnPaths,
    runTestsVerbose,

    classifyRun: classifyGoRun,
    isMissingSymbolError,

    testPathKey(relPath: string): string {
      return testPathKeyFromRelPath(relPath);
    },

    isSourceFile,
    isTestFile,
    extractSymbols,

    computeMutationScore(opts) {
      return computeGoMutationScore(() => runTests(opts.workDir, opts.testRelPath), opts, classifyGoRun);
    },

    runStaticGates,
  };
}
