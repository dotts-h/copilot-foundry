import { join } from "node:path";
import type { BaselineTestResult } from "../phases/baseline.js";
import { runCommand } from "../exec.js";
import { computeJsMutationScore } from "./jsMutation.js";
import { classifyJsRun } from "./jsClassify.js";
import { detectJsContext, findTsconfig, resolveBin, type JsContext } from "./jsContext.js";
import type { FileSymbols } from "../phases/map.js";
import type { MutationOptions, RunClassification, StaticGateResult, TargetRunner, TestRunResult } from "./types.js";
import { extractJsSymbols } from "./jsSymbols.js";

const SINGLE_ASSERTION_TRIANGULATION_WARNING =
  "only one assertion found -- a single example does not triangulate; consider a second, differently-valued case";

export function lintRedTestJs(testSource: string): import("../gates/redLinter.js").RedLintResult {
  const blocking: string[] = [];
  const warnings: string[] = [];

  if (testSource.trim().length === 0) {
    blocking.push("test file is empty");
    return { blocking, warnings };
  }

  const expectCount = (testSource.match(/\bexpect\s*\(/g) ?? []).length;
  const assertLineCount = (testSource.match(/^\s*assert\b/gm) ?? []).length;
  const assertionCount = expectCount + assertLineCount;

  if (assertionCount === 0) {
    blocking.push("no assertions found (expect(...) or assert)");
  } else if (assertionCount === 1) {
    warnings.push(SINGLE_ASSERTION_TRIANGULATION_WARNING);
  }

  return { blocking, warnings };
}

export const VITEST_RED_PROMPT_RULES =
  "Import the target module with a dynamic `await import(...)` INSIDE the async test function — never a top-level static import of a symbol that may not exist yet, so a missing export fails only your test instead of breaking collection of the whole file.";

export const JEST_RED_PROMPT_RULES =
  "Load the target module with `require(...)` INSIDE the test function — never a top-level import of a symbol that may not exist yet, so a missing export fails only your test.";

export { JEST_HARNESS_ERROR_MARKERS, VITEST_HARNESS_ERROR_MARKERS, classifyJsRun } from "./jsClassify.js";

/** Convert a git-root-relative path to a package-relative argv path (or absolute when outside the package). */
export function toPackageRelative(packageRelPath: string, relPath: string, workDir?: string): string {
  if (packageRelPath === "") return relPath;
  if (relPath === packageRelPath) return ".";
  const prefix = `${packageRelPath}/`;
  if (relPath.startsWith(prefix)) return relPath.slice(prefix.length);
  if (workDir !== undefined) return join(workDir, relPath);
  return relPath;
}

/** Test seam for mocking subprocess execution. */
export const jsRunnerDeps = { runCommand };

const JS_SOURCE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".mjs", ".cjs", ".jsx"];
const EXCLUDED_PATH_SEGMENTS = ["node_modules", "dist", "build", "coverage"];

export const JS_MISSING_SYMBOL_RED_NOTE =
  "does NOT exist yet — import it inside the test function (see the import rule above); the test must fail because the symbol is missing, not crash collection.";

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function isMissingSymbolError(raw: string, functionName: string): boolean {
  const name = escapeRegExp(functionName);
  const patterns = [
    new RegExp(`does not provide an export named '${name}'`),
    new RegExp(`has no exported member '${name}'`),
    new RegExp(`has no exported member named '${name}'`),
    new RegExp(`${name} is not a function`),
    new RegExp(`${name} is not defined`),
    new RegExp(`Property '${name}' does not exist`),
    new RegExp(`Cannot destructure property '${name}'`),
  ];
  return patterns.some((pattern) => pattern.test(raw));
}

function stripAnsi(raw: string): string {
  return raw.replace(/\u001b\[[0-9;]*m/g, "");
}

export function parseVitestVerboseOutput(raw: string): BaselineTestResult[] {
  const results: BaselineTestResult[] = [];
  const cleaned = stripAnsi(raw);
  const lineRegex = /^\s*([✓√×✗✕↓]|skipped)\s+(\S+\.(?:[cm]?[jt]sx?|m[jt]s))\s*>\s*(.+)$/gm;
  let match: RegExpExecArray | null;
  while ((match = lineRegex.exec(cleaned)) !== null) {
    const marker = match[1];
    const filePath = match[2];
    const testName = match[3].trim();
    let outcome: BaselineTestResult["outcome"];
    if (marker === "✓" || marker === "√") {
      outcome = "passed";
    } else if (marker === "×" || marker === "✗" || marker === "✕") {
      outcome = "failed";
    } else {
      outcome = "skipped";
    }
    results.push({ nodeId: `${filePath}::${testName}`, outcome });
  }
  return results;
}

export function parseJestVerboseOutput(raw: string): BaselineTestResult[] {
  const results: BaselineTestResult[] = [];
  let currentFile: string | null = null;
  for (const line of raw.split("\n")) {
    const headerMatch = /^(PASS|FAIL)\s+(\S+)/.exec(line.trim());
    if (headerMatch) {
      currentFile = headerMatch[2];
      continue;
    }
    if (!currentFile) continue;
    const testMatch = /^\s*([✓✕○])\s+(.+?)(?:\s+\(\d+\s*m?s\))?$/.exec(line);
    if (!testMatch) continue;
    const marker = testMatch[1];
    const testName = testMatch[2].trim();
    let outcome: BaselineTestResult["outcome"];
    if (marker === "✓") {
      outcome = "passed";
    } else if (marker === "✕") {
      outcome = "failed";
    } else {
      outcome = "skipped";
    }
    results.push({ nodeId: `${currentFile}::${testName}`, outcome });
  }
  return results;
}

interface WorkContext {
  workPackageDir: string;
  workWorkspaceRoot: string;
  testBin: string | null;
  tscBin: string | null;
  tsconfigPath: string | null;
}

async function resolveWorkContext(
  workDir: string,
  workspaceRelPath: string,
  packageRelPath: string,
  framework: "vitest" | "jest",
): Promise<WorkContext> {
  const workWorkspaceRoot = join(workDir, workspaceRelPath);
  const workPackageDir = join(workDir, packageRelPath);
  const testBinName = framework === "vitest" ? "vitest" : "jest";
  const testBin = await resolveBin(workPackageDir, workWorkspaceRoot, testBinName);
  const tscBin = await resolveBin(workPackageDir, workWorkspaceRoot, "tsc");
  const tsconfigPath = await findTsconfig(workPackageDir, workWorkspaceRoot);
  return { workPackageDir, workWorkspaceRoot, testBin, tscBin, tsconfigPath };
}

function requireTestBin(bin: string | null, framework: string): string {
  if (!bin) {
    throw new Error(`${framework} binary not found in worktree node_modules/.bin`);
  }
  return bin;
}

export async function createJsRunner(targetDir: string): Promise<TargetRunner> {
  const ctx: JsContext = await detectJsContext(targetDir);
  const redPromptRules = ctx.framework === "vitest" ? VITEST_RED_PROMPT_RULES : JEST_RED_PROMPT_RULES;

  async function ensureEnv(workDir: string): Promise<void> {
    const { workWorkspaceRoot } = await resolveWorkContext(
      workDir,
      ctx.workspaceRelPath,
      ctx.packageRelPath,
      ctx.framework,
    );
    let installResult;
    switch (ctx.packageManager) {
      case "pnpm":
        installResult = await jsRunnerDeps.runCommand("pnpm", ["install", "--prefer-offline"], {
          cwd: workWorkspaceRoot,
          timeoutMs: 300_000,
        });
        break;
      case "yarn":
        installResult = await jsRunnerDeps.runCommand("yarn", ["install"], {
          cwd: workWorkspaceRoot,
          timeoutMs: 300_000,
        });
        break;
      case "bun":
        installResult = await jsRunnerDeps.runCommand("bun", ["install"], {
          cwd: workWorkspaceRoot,
          timeoutMs: 300_000,
        });
        break;
      case "npm":
      default:
        installResult = await jsRunnerDeps.runCommand("npm", ["ci"], {
          cwd: workWorkspaceRoot,
          timeoutMs: 300_000,
        });
        if (installResult.exitCode !== 0) {
          installResult = await jsRunnerDeps.runCommand("npm", ["install"], {
            cwd: workWorkspaceRoot,
            timeoutMs: 300_000,
          });
        }
        break;
    }
    if (installResult.exitCode !== 0) {
      throw new Error(installResult.stdout + installResult.stderr);
    }
  }

  async function runTests(workDir: string, targetRelPath?: string): Promise<TestRunResult> {
    const work = await resolveWorkContext(workDir, ctx.workspaceRelPath, ctx.packageRelPath, ctx.framework);
    const testBin = requireTestBin(work.testBin, ctx.framework);

    if (ctx.framework === "vitest") {
      const args = ["run", targetRelPath !== undefined ? toPackageRelative(ctx.packageRelPath, targetRelPath, workDir) : "."];
      const result = await jsRunnerDeps.runCommand(testBin, args, {
        cwd: work.workPackageDir,
        env: { CI: "1" },
        timeoutMs: 120_000,
      });
      return { exitCode: result.exitCode, raw: result.stdout + result.stderr };
    }

    const args = [
      "--ci",
      ...(targetRelPath !== undefined ? [toPackageRelative(ctx.packageRelPath, targetRelPath, workDir)] : []),
    ];
    const result = await jsRunnerDeps.runCommand(testBin, args, {
      cwd: work.workPackageDir,
      env: { CI: "1" },
      timeoutMs: 120_000,
    });
    return { exitCode: result.exitCode, raw: result.stdout + result.stderr };
  }

  async function runTestsOnPaths(workDir: string, paths: string[]): Promise<TestRunResult> {
    const work = await resolveWorkContext(workDir, ctx.workspaceRelPath, ctx.packageRelPath, ctx.framework);
    const testBin = requireTestBin(work.testBin, ctx.framework);
    const targetPaths = paths.length > 0 ? paths : ["."];
    if (ctx.framework === "vitest") {
      const args = [
        "run",
        ...targetPaths.map((p) => toPackageRelative(ctx.packageRelPath, p, workDir)),
      ];
      const result = await jsRunnerDeps.runCommand(testBin, args, {
        cwd: work.workPackageDir,
        env: { CI: "1" },
        timeoutMs: 120_000,
      });
      return { exitCode: result.exitCode, raw: result.stdout + result.stderr };
    }

    const args = ["--ci", ...targetPaths.map((p) => toPackageRelative(ctx.packageRelPath, p, workDir))];
    const result = await jsRunnerDeps.runCommand(testBin, args, {
      cwd: work.workPackageDir,
      env: { CI: "1" },
      timeoutMs: 120_000,
    });
    return { exitCode: result.exitCode, raw: result.stdout + result.stderr };
  }

  async function runTestsVerbose(workDir: string): Promise<{ exitCode: number; tests: BaselineTestResult[] }> {
    const work = await resolveWorkContext(workDir, ctx.workspaceRelPath, ctx.packageRelPath, ctx.framework);
    const testBin = requireTestBin(work.testBin, ctx.framework);

    if (ctx.framework === "vitest") {
      const result = await jsRunnerDeps.runCommand(testBin, ["run", "--reporter=verbose"], {
        cwd: work.workPackageDir,
        env: { CI: "1" },
        timeoutMs: 120_000,
      });
      return {
        exitCode: result.exitCode,
        tests: parseVitestVerboseOutput(result.stdout + result.stderr),
      };
    }

    const result = await jsRunnerDeps.runCommand(testBin, ["--ci", "--verbose"], {
      cwd: work.workPackageDir,
      env: { CI: "1" },
      timeoutMs: 120_000,
    });
    return {
      exitCode: result.exitCode,
      tests: parseJestVerboseOutput(result.stdout + result.stderr),
    };
  }

  function isSourceFile(relPath: string): boolean {
    if (relPath.endsWith(".d.ts")) return false;
    const segments = relPath.split("/");
    if (segments.some((seg) => EXCLUDED_PATH_SEGMENTS.includes(seg))) return false;
    const dot = relPath.lastIndexOf(".");
    if (dot === -1) return false;
    return JS_SOURCE_EXTENSIONS.includes(relPath.slice(dot));
  }

  function isTestFile(relPath: string): boolean {
    const base = relPath.split("/").pop() ?? relPath;
    const inTestsDir = relPath.includes("/__tests__/") || relPath.startsWith("__tests__/");
    const testPattern = /\.(test|spec)\.(?:[cm]?[jt]sx?|m[jt]s)$/;
    return inTestsDir || testPattern.test(base);
  }

  async function extractSymbols(targetDirForExtract: string, files: string[]): Promise<Record<string, FileSymbols>> {
    return extractJsSymbols(targetDirForExtract, files);
  }

  async function runStaticGates(workDir: string): Promise<StaticGateResult[]> {
    const work = await resolveWorkContext(workDir, ctx.workspaceRelPath, ctx.packageRelPath, ctx.framework);
    if (!work.tscBin || !work.tsconfigPath) return [];
    const result = await jsRunnerDeps.runCommand(work.tscBin, ["--noEmit", "-p", work.tsconfigPath], {
      cwd: join(work.tsconfigPath, ".."),
      timeoutMs: 120_000,
    });
    return [
      {
        name: "tsc --noEmit",
        passed: result.exitCode === 0,
        raw: result.stdout + result.stderr,
      },
    ];
  }

  return {
    language: "js",
    testFrameworkName: ctx.framework,
    redPromptRules,
    missingSymbolRedNote: JS_MISSING_SYMBOL_RED_NOTE,

    ensureEnv,
    runTests,
    runTestsOnPaths,
    runTestsVerbose,

    classifyRun(result: TestRunResult): RunClassification {
      return classifyJsRun(ctx.framework, result);
    },

    isMissingSymbolError,

    testPathKey(relPath: string): string {
      return toPackageRelative(ctx.packageRelPath, relPath);
    },

    isSourceFile,
    isTestFile,
    extractSymbols,

    computeMutationScore(opts: MutationOptions) {
      return computeJsMutationScore(() => runTests(opts.workDir, opts.testRelPath), opts, ctx.framework);
    },

    runStaticGates,

    lintRedTest: lintRedTestJs,
  };
}
