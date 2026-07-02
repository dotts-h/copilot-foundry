import type { TargetRunner } from "../runner/types.js";
import { soundPaths } from "../soundPaths.js";
import type { BaselineReport, BaselineTestResult } from "./baseline.js";
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

function isFailedOutcome(outcome: string): boolean {
  return outcome === "failed" || outcome === "error";
}

function nodePath(nodeId: string): string {
  return nodeId.split("::")[0];
}

/** Distinct test-file paths with at least one failed/error test in `tests`. */
function failingPaths(tests: BaselineTestResult[]): Set<string> {
  return new Set(tests.filter((t) => isFailedOutcome(t.outcome)).map((t) => nodePath(t.nodeId)));
}

/** Message when a verbose run yields no results and a nonzero exit (harness-level failure), else null. */
function unparseableRunMessage(verbose: { exitCode: number; tests: unknown[] }, levelName: string): string | null {
  if (verbose.tests.length === 0 && verbose.exitCode !== 0) {
    return `${levelName} run produced no parseable results (exit ${verbose.exitCode})`;
  }
  return null;
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
      const currentFailing = failingPaths(verbose.tests);

      const parseFailure = unparseableRunMessage(verbose, "full-suite");
      let passed: boolean;
      let raw: string;
      if (parseFailure) {
        passed = false;
        raw = parseFailure;
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
    const initialPassed = opts.runner.classifyRun(outcome) === "passed";

    if (initialPassed || level !== "impacted-subgraph") {
      results.push({ level, passed: initialPassed, raw: outcome.raw });
      if (!initialPassed) {
        return { passed: false, failedLevel: level, levels: results };
      }
      continue;
    }

    // impacted-subgraph is baseline-relative: a failure here only fails the level if it
    // regresses a path that was sound at baseline. Pre-existing baseline failures among the
    // level's own paths are tolerated.
    const verbose = await opts.runner.runTestsVerbose(opts.targetDir);
    const parseFailure = unparseableRunMessage(verbose, "impacted-subgraph");
    if (parseFailure) {
      results.push({ level, passed: false, raw: parseFailure });
      return { passed: false, failedLevel: level, levels: results };
    }

    const ownPathKeys = new Set(paths.map((p) => opts.runner.testPathKey(p)));
    const baselineFailingPaths = failingPaths(opts.baseline.tests);
    const currentFailingOwn = new Set([...failingPaths(verbose.tests)].filter((p) => ownPathKeys.has(p)));

    const newRegressions = [...currentFailingOwn].filter((p) => !baselineFailingPaths.has(p));
    const tolerated = [...currentFailingOwn].filter((p) => baselineFailingPaths.has(p));

    const passed = newRegressions.length === 0;
    const raw = passed
      ? tolerated.length > 0
        ? `tolerated pre-existing baseline failures: ${tolerated.join(", ")}`
        : outcome.raw
      : `new failures vs baseline: ${newRegressions.join(", ")}`;

    results.push({ level, passed, raw });
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
