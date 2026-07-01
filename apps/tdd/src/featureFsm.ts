import { writeArtifact } from "./artifacts/vault.js";
import type { Backend } from "./backend/types.js";
import { runCommand } from "./exec.js";
import { classifyRedOutcome, type RedOutcome } from "./gates/redGate.js";
import { runGreenWithRepair } from "./gates/greenGate.js";
import type { RedLintResult } from "./gates/redLinter.js";
import { writeLeashConfig } from "./gates/leash.js";
import { mapRepo, type RepoMap } from "./phases/map.js";
import { runBaseline, type BaselineReport } from "./phases/baseline.js";
import { computeScope, type ScopeReport } from "./phases/scope.js";
import { planSlices, type PlannedSlice } from "./phases/plan.js";
import { writeRunState } from "./runStore.js";
import { validateFeatureRunSpec, type FeatureRunSpec } from "./types.js";

export interface SliceExecutionResult {
  slice: PlannedSlice;
  redOutcome: RedOutcome;
  redGatePassed: boolean;
  redLint: RedLintResult;
  greenGatePassed: boolean;
  greenIterationsUsed: number;
  greenEscalated: boolean;
  diffGuardViolated: boolean;
}

export type FeatureRunStatus = "completed" | "plan_only" | "red_gate_failed" | "green_gate_exhausted";

export interface FeatureLedger {
  runId: string;
  mode: "feature";
  mapSummary: { fileCount: number; testFileCount: number };
  baselineSummary: { total: number; passed: number; failed: number };
  scopeReport: ScopeReport;
  slices: PlannedSlice[];
  sliceResults: SliceExecutionResult[];
  status: FeatureRunStatus;
  completedAt: string;
}

function summarizeBaseline(baseline: BaselineReport): { total: number; passed: number; failed: number } {
  return {
    total: baseline.tests.length,
    passed: baseline.tests.filter((t) => t.outcome === "passed").length,
    failed: baseline.tests.filter((t) => t.outcome === "failed" || t.outcome === "error").length,
  };
}

function buildRedPrompt(slice: PlannedSlice): string {
  return (
    `Write ONLY a failing pytest test at ${slice.testRelPath} for this behavior: ${slice.description}. ` +
    `The implementation lives at ${slice.implRelPath} and does not yet satisfy this behavior. ` +
    "Do NOT implement or modify the implementation file. Do not create or modify any other file."
  );
}

function buildGreenPrompt(slice: PlannedSlice, lastFailureOutput: string | undefined): string {
  const base =
    `The test at ${slice.testRelPath} is currently failing. Make it pass with the minimal correct ` +
    `implementation in ${slice.implRelPath} for: ${slice.description}. Do NOT modify ${slice.testRelPath} ` +
    "under any circumstances -- it is locked and any attempt to edit it will be reverted and the slice will fail.";
  if (lastFailureOutput === undefined) return base;
  return `${base}\n\nThe previous attempt failed with:\n${lastFailureOutput}`;
}

async function markProgress(
  artifactRoot: string,
  runId: string,
  startedAt: string,
  phase: string,
  extra?: { sliceIndex?: number; totalSlices?: number },
): Promise<void> {
  await writeRunState(artifactRoot, runId, {
    status: "running",
    progress: { phase, ...extra },
    startedAt,
    updatedAt: new Date().toISOString(),
  });
}

export async function runFeature(
  spec: FeatureRunSpec,
  backend: Backend,
  artifactRoot: string,
  runId: string,
): Promise<FeatureLedger> {
  validateFeatureRunSpec(spec);

  const startedAt = new Date().toISOString();
  await markProgress(artifactRoot, runId, startedAt, "map");

  const repoMap: RepoMap = await mapRepo(spec.targetDir);
  await writeArtifact(artifactRoot, runId, "map", repoMap);

  await markProgress(artifactRoot, runId, startedAt, "baseline");
  const baseline = await runBaseline(spec.venvDir, spec.targetDir);
  await writeArtifact(artifactRoot, runId, "baseline", baseline);

  await markProgress(artifactRoot, runId, startedAt, "scope");
  const scopeReport = computeScope(repoMap, spec.targetHint, spec.scope);
  await writeArtifact(artifactRoot, runId, "scope", scopeReport);

  await markProgress(artifactRoot, runId, startedAt, "plan");
  const slices = await planSlices({
    backend,
    model: spec.models.plan,
    targetDir: spec.targetDir,
    featureDescription: spec.featureDescription,
    repoMap,
    scopeReport,
  });
  await writeArtifact(artifactRoot, runId, "plan", slices);

  const finish = async (status: FeatureRunStatus, sliceResults: SliceExecutionResult[]): Promise<FeatureLedger> => {
    const ledger: FeatureLedger = {
      runId,
      mode: "feature",
      mapSummary: { fileCount: repoMap.files.length, testFileCount: repoMap.testFiles.length },
      baselineSummary: summarizeBaseline(baseline),
      scopeReport,
      slices,
      sliceResults,
      status,
      completedAt: new Date().toISOString(),
    };
    await writeArtifact(artifactRoot, runId, "featureLedger", ledger);
    await writeRunState(artifactRoot, runId, {
      status: "done",
      progress: { phase: status, totalSlices: slices.length },
      startedAt,
      updatedAt: ledger.completedAt,
    });
    return ledger;
  };

  if (spec.hitl === "plan-only") {
    return finish("plan_only", []);
  }

  const sliceResults: SliceExecutionResult[] = [];

  for (let i = 0; i < slices.length; i++) {
    const slice = slices[i];
    await markProgress(artifactRoot, runId, startedAt, "slice", { sliceIndex: i, totalSlices: slices.length });

    await writeLeashConfig(spec.targetDir, [slice.testRelPath]);
    await backend.runPhase({ cwd: spec.targetDir, model: spec.models.red, prompt: buildRedPrompt(slice) });
    await runCommand("git", ["add", "-A"], { cwd: spec.targetDir });
    await runCommand("git", ["commit", "-q", "-m", `red: ${runId} slice ${i}`], { cwd: spec.targetDir });

    const redResult = await classifyRedOutcome({
      targetDir: spec.targetDir,
      venvDir: spec.venvDir,
      testRelPath: slice.testRelPath,
      baseline,
    });

    if (!redResult.passed) {
      sliceResults.push({
        slice,
        redOutcome: redResult.outcome,
        redGatePassed: false,
        redLint: redResult.lint,
        greenGatePassed: false,
        greenIterationsUsed: 0,
        greenEscalated: false,
        diffGuardViolated: false,
      });
      return finish("red_gate_failed", sliceResults);
    }

    const greenResult = await runGreenWithRepair({
      backend,
      targetDir: spec.targetDir,
      venvDir: spec.venvDir,
      testRelPath: slice.testRelPath,
      greenModel: spec.models.green,
      escalationModel: spec.models.escalation,
      maxIterations: spec.maxRepairIterations,
      buildPrompt: (lastFailure) => buildGreenPrompt(slice, lastFailure),
    });

    sliceResults.push({
      slice,
      redOutcome: redResult.outcome,
      redGatePassed: true,
      redLint: redResult.lint,
      greenGatePassed: greenResult.passed,
      greenIterationsUsed: greenResult.iterationsUsed,
      greenEscalated: greenResult.escalated,
      diffGuardViolated: greenResult.diffGuardViolated,
    });

    if (!greenResult.passed) {
      return finish("green_gate_exhausted", sliceResults);
    }

    await runCommand("git", ["add", "-A"], { cwd: spec.targetDir });
    await runCommand("git", ["commit", "-q", "-m", `green: ${runId} slice ${i}`], { cwd: spec.targetDir });
  }

  return finish("completed", sliceResults);
}
