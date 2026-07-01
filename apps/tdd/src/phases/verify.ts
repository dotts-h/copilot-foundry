import { join } from "node:path";
import { runCommand } from "../exec.js";
import type { RepoMap } from "./map.js";
import type { ScopeReport } from "./scope.js";

export type VerifyLevel = "focused" | "spec" | "impacted-subgraph" | "full-suite";

export interface VerifyLevelResult {
  level: VerifyLevel;
  passed: boolean;
  raw: string;
}

export interface VerifyResult {
  passed: boolean;
  failedLevel?: VerifyLevel;
  levels: VerifyLevelResult[];
}

export interface VerifyLadderOptions {
  venvDir: string;
  targetDir: string;
  touchedTestPaths: string[];
  newTestPaths: string[];
  repoMap: RepoMap;
  scopeReport: ScopeReport;
}

async function runPytestOnPaths(
  venvDir: string,
  cwd: string,
  paths: string[],
): Promise<{ exitCode: number; raw: string }> {
  const pytestBin = join(venvDir, "bin", "pytest");
  const args = ["-q", ...(paths.length > 0 ? paths : ["."])];
  const result = await runCommand(pytestBin, args, {
    cwd,
    env: { PYTHONDONTWRITEBYTECODE: "1" },
    timeoutMs: 60_000,
  });
  return { exitCode: result.exitCode, raw: result.stdout + result.stderr };
}

const ALL_PASSED = 0;

export async function runVerifyLadder(opts: VerifyLadderOptions): Promise<VerifyResult> {
  const inScopeTestFiles = opts.repoMap.testFiles.filter((f) => opts.scopeReport.inScope.includes(f));

  const levels: Array<{ level: VerifyLevel; paths: string[] }> = [
    { level: "focused", paths: [...new Set(opts.touchedTestPaths)] },
    { level: "spec", paths: [...new Set(opts.newTestPaths)] },
    {
      level: "impacted-subgraph",
      paths: inScopeTestFiles.length > 0 ? inScopeTestFiles : opts.touchedTestPaths,
    },
    { level: "full-suite", paths: [] },
  ];

  const results: VerifyLevelResult[] = [];
  for (const { level, paths } of levels) {
    const outcome = await runPytestOnPaths(opts.venvDir, opts.targetDir, paths);
    const passed = outcome.exitCode === ALL_PASSED;
    results.push({ level, passed, raw: outcome.raw });
    if (!passed) {
      return { passed: false, failedLevel: level, levels: results };
    }
  }

  return { passed: true, levels: results };
}
