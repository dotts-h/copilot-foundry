import type { TargetRunner } from "../runner/types.js";
import { soundPaths } from "../soundPaths.js";
import type { BaselineReport } from "./baseline.js";
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
  baseline: BaselineReport;
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
    if (level === "full-suite") {
      const verbose = await opts.runner.runTestsVerbose(opts.targetDir);
      const baselineSound = soundPaths(opts.baseline.tests);
      const currentFailing = new Set(
        verbose.tests
          .filter((t) => t.outcome === "failed" || t.outcome === "error")
          .map((t) => t.nodeId.split("::")[0]),
      );

      let passed: boolean;
      let raw: string;
      if (verbose.tests.length === 0 && verbose.exitCode !== 0) {
        passed = false;
        raw = `full-suite run produced no parseable results (exit ${verbose.exitCode})`;
      } else {
        const newFailures = [...baselineSound].filter((p) => currentFailing.has(p));
        passed = newFailures.length === 0;
        raw = passed ? "" : `new failures vs baseline: ${newFailures.join(", ")}`;
      }

      results.push({ level, passed, raw });
      if (!passed) {
        return { passed: false, failedLevel: level, levels: results };
      }
      continue;
    }

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
