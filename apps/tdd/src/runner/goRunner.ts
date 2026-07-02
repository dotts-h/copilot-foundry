import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { RedLintResult } from "../gates/redLinter.js";
import type { BaselineTestResult } from "../phases/baseline.js";
import { runCommand } from "../exec.js";
import { computeGoMutationScore } from "./goMutation.js";
import { extractGoSymbols } from "./goSymbols.js";
import type { RunClassification, StaticGateResult, TargetRunner, TestRunResult } from "./types.js";

const SINGLE_ASSERTION_TRIANGULATION_WARNING =
  "only one assertion found -- a single example does not triangulate; consider a second, differently-valued case";

export function lintRedTestGo(testSource: string): RedLintResult {
  const blocking: string[] = [];
  const warnings: string[] = [];

  if (testSource.trim().length === 0) {
    blocking.push("test file is empty");
    return { blocking, warnings };
  }

  const tCallCount = (testSource.match(/\bt\.(Error|Errorf|Fatal|Fatalf|FailNow)\s*\(/g) ?? []).length;
  const testifyCount = (testSource.match(/\b(assert|require)\.\w+\s*\(/g) ?? []).length;
  const assertionCount = tCallCount + testifyCount;

  if (assertionCount === 0) {
    blocking.push("no assertions found (t.Error/t.Errorf or assert/require)");
  } else if (assertionCount === 1 && !/\brange\b/.test(testSource)) {
    warnings.push(SINGLE_ASSERTION_TRIANGULATION_WARNING);
  }

  return { blocking, warnings };
}

export const GO_RED_PROMPT_RULES =
  "Reference the new symbol directly in your test as if it already exists. " +
  "In Go a missing symbol makes the package fail to COMPILE — that compile failure " +
  "(`undefined: <symbol>`) IS the expected first RED. Do NOT stub or declare the symbol " +
  "yourself, and do not use reflection tricks to avoid the compile error.";

export const GO_MISSING_SYMBOL_RED_NOTE =
  "does NOT exist yet — your test will fail to compile with `undefined: <symbol>` " +
  "(or a related compiler diagnostic, e.g. `<expr> undefined (type T has no field or " +
  "method <symbol>)` or `unknown field <symbol> in struct literal`); that compile " +
  "failure is the expected RED, do not stub the symbol.";

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

// Generic (not functionName-pinned) Go compiler missing-symbol diagnostic shapes. These
// are checked only after the functionName-pinned fast path above misses, so that a
// legitimate first RED referencing a brand-new struct field/method on an *existing* type
// (e.g. `dt.Control undefined (type draftedTaskJSON has no field or method Control)`) is
// still classified as missing_symbol rather than collection_error.
//
// Tradeoff accepted: once we fall back to these broad, ANY-identifier patterns, a typo'd
// identifier in the RED test (e.g. referencing "Contrl" instead of "Control") would also
// be classified as missing_symbol instead of collection_error. That's acceptable because
// the orchestrator's branch review is the backstop that catches a RED test asserting
// against the wrong symbol.
// Deliberately does NOT include a bare `undefined: X` pattern here: that shape is already
// covered by the functionName-pinned fast path above, and a functionName-agnostic version
// of it would also match an unrelated symbol (e.g. `undefined: Bar` while the RED test was
// meant to reference `Foo`), which is a real mismatch we still want surfaced as
// collection_error rather than papered over as missing_symbol.
const GENERIC_MISSING_SYMBOL_PATTERNS = [
  /\S+ undefined \(type \S+ has no field or method \S+\)/,
  /unknown field \S+ in struct literal/,
  /\S+ not declared by package/,
];

export function isMissingSymbolError(raw: string, functionName: string): boolean {
  const name = escapeRegExp(functionName);
  const patterns = [
    new RegExp(`undefined: (\\w+\\.)?${name}\\b`),
    new RegExp(`${name} not declared by package`),
    new RegExp(`has no field or method ${name}`),
  ];
  if (patterns.some((pattern) => pattern.test(raw))) return true;
  return GENERIC_MISSING_SYMBOL_PATTERNS.some((pattern) => pattern.test(raw));
}

const GO_TEST_ENV: Record<string, string> = { GOFLAGS: "-count=1" };

async function readModulePathFromWorkDir(workDir: string): Promise<string> {
  try {
    const content = await readFile(join(workDir, "go.mod"), "utf8");
    return parseModulePath(content);
  } catch {
    return "";
  }
}

export function createGoRunner(_targetDir: string): TargetRunner {
  async function runGoTestPkgs(workDir: string, pkgs: string[]): Promise<TestRunResult> {
    const result = await goRunnerDeps.runCommand("go", ["test", ...pkgs], {
      cwd: workDir,
      env: GO_TEST_ENV,
      timeoutMs: 180_000,
    });
    return { exitCode: result.exitCode, raw: result.stdout + result.stderr };
  }

  async function runTests(workDir: string, targetRelPath?: string): Promise<TestRunResult> {
    const pkg = targetRelPath !== undefined ? packageOf(targetRelPath) : "./...";
    return runGoTestPkgs(workDir, [pkg]);
  }

  async function runTestsOnPaths(workDir: string, paths: string[]): Promise<TestRunResult> {
    const pkgs = paths.length === 0 ? ["./..."] : [...new Set(paths.map(packageOf))];
    return runGoTestPkgs(workDir, pkgs);
  }

  async function runTestsVerbose(workDir: string): Promise<{ exitCode: number; tests: BaselineTestResult[] }> {
    const result = await goRunnerDeps.runCommand("go", ["test", "./...", "-v"], {
      cwd: workDir,
      env: GO_TEST_ENV,
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

    testPathKey: testPathKeyFromRelPath,

    isSourceFile,
    isTestFile,
    extractSymbols: extractGoSymbols,

    computeMutationScore(opts) {
      return computeGoMutationScore(() => runTests(opts.workDir, opts.testRelPath), opts, classifyGoRun);
    },

    runStaticGates,

    lintRedTest: lintRedTestGo,
  };
}
