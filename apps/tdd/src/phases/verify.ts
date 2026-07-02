import type { TargetRunner } from "../runner/types.js";
import type { RepoMap } from "./map.js";
import type { ScopeReport } from "./scope.js";

export type VerifyLevel = "focused" | "spec" | "impacted-subgraph" | "full-suite" | "static-gates";

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
  runner: TargetRunner;
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
    const outcome = await opts.runner.runTestsOnPaths(opts.targetDir, paths);
    const passed = opts.runner.classifyRun(outcome) === "passed";
    results.push({ level, passed, raw: outcome.raw });
    if (!passed) {
      return { passed: false, failedLevel: level, levels: results };
    }
  }

  const staticGates = await opts.runner.runStaticGates(opts.targetDir);
  for (const gate of staticGates) {
    results.push({ level: "static-gates", passed: gate.passed, raw: gate.raw });
    if (!gate.passed) {
      return { passed: false, failedLevel: "static-gates", levels: results };
    }
  }

  return { passed: true, levels: results };
}
