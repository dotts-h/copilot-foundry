import type { TestToolchain } from "../toolchain.js";
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
  toolchain: TestToolchain;
  targetDir: string;
  touchedTestPaths: string[];
  newTestPaths: string[];
  repoMap: RepoMap;
  scopeReport: ScopeReport;
}

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
    const outcome = await opts.toolchain.runOnPaths(opts.targetDir, paths);
    results.push({ level, passed: outcome.passed, raw: outcome.raw });
    if (!outcome.passed) {
      return { passed: false, failedLevel: level, levels: results };
    }
  }

  return { passed: true, levels: results };
}
