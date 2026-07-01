import { writeArtifact } from "./artifacts/vault.js";
import type { Backend } from "./backend/types.js";
import { runCommand } from "./exec.js";
import { attemptRefactor } from "./gates/refactorGate.js";
import { classifyRedOutcome, type RedOutcome } from "./gates/redGate.js";
import { runGreenWithRepair } from "./gates/greenGate.js";
import type { RedLintResult } from "./gates/redLinter.js";
import { computeMutationScore, type MutationScoreResult } from "./gates/mutationGate.js";
import { mapRepo, type RepoMap } from "./phases/map.js";
import { runBaseline, runPytestVerbose, type BaselineReport } from "./phases/baseline.js";
import { computeScope, type ScopeReport } from "./phases/scope.js";
import { planSlices, type PlannedSlice } from "./phases/plan.js";
import { buildCheckpoint } from "./phases/checkpoint.js";
import { runVerifyLadder, type VerifyResult } from "./phases/verify.js";
import { buildAcceptanceLedger, type AcceptanceLedger } from "./phases/accept.js";
import { writeback, type WritebackResult } from "./phases/writeback.js";
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
  refactorApplied: boolean;
  mutationScore: MutationScoreResult | null;
}

export type FeatureRunStatus =
  | "accepted"
  | "verify_failed"
  | "mutation_gate_failed"
  | "completed_with_regressions"
  | "plan_only"
  | "red_gate_failed"
  | "green_gate_exhausted";

export interface FeatureLedger {
  runId: string;
  mode: "feature";
  mapSummary: { fileCount: number; testFileCount: number };
  baselineSummary: { total: number; passed: number; failed: number };
  scopeReport: ScopeReport;
  slices: PlannedSlice[];
  sliceResults: SliceExecutionResult[];
  verifyResult: VerifyResult | null;
  acceptanceLedger: AcceptanceLedger | null;
  writebackResult: WritebackResult | null;
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
    "Include at least two assertions with different, non-trivially-related expected values (not just one " +
    "example) so the test actually triangulates the behavior and cannot be satisfied by a function that " +
    "always returns a single constant. " +
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

function buildRefactorPrompt(slice: PlannedSlice): string {
  return (
    `The test at ${slice.testRelPath} is currently passing against ${slice.implRelPath}. Mechanically ` +
    "clean up the implementation (naming, redundant code, obvious simplifications) WITHOUT changing " +
    `its behavior. Do NOT modify ${slice.testRelPath} under any circumstances -- it is locked and any ` +
    "attempt to edit it will be reverted."
  );
}

const SAFE_REL_PATH = /^[\w][\w./-]*$/;
const SAFE_IDENTIFIER = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

function validateSlicePaths(slices: PlannedSlice[]): void {
  for (const slice of slices) {
    for (const relPath of [slice.implRelPath, slice.testRelPath]) {
      if (relPath.startsWith("/") || relPath.split("/").includes("..") || !SAFE_REL_PATH.test(relPath)) {
        throw new Error(
          `runFeature: planned slice path "${relPath}" is not a safe repo-relative path (must match ${SAFE_REL_PATH}, no leading "/", no ".." segments)`,
        );
      }
    }
    if (!SAFE_IDENTIFIER.test(slice.functionName)) {
      throw new Error(
        `runFeature: planned slice functionName "${slice.functionName}" is not a valid Python identifier`,
      );
    }
  }
}

async function commitAll(dir: string, message: string): Promise<void> {
  await runCommand("git", ["add", "-A"], { cwd: dir, timeoutMs: 30_000 });
  const result = await runCommand("git", ["commit", "-q", "-m", message], { cwd: dir, timeoutMs: 30_000 });
  if (result.exitCode !== 0 && !/nothing to commit/.test(result.stdout + result.stderr)) {
    throw new Error(`commitAll: git commit failed (exit ${result.exitCode}): ${result.stdout}${result.stderr}`);
  }
}

async function currentHead(dir: string): Promise<string> {
  const result = await runCommand("git", ["rev-parse", "HEAD"], { cwd: dir, timeoutMs: 15_000 });
  return result.stdout.trim();
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
  validateSlicePaths(slices);
  await writeArtifact(artifactRoot, runId, "plan", slices);

  const finish = async (
    status: FeatureRunStatus,
    sliceResults: SliceExecutionResult[],
    verifyResult: VerifyResult | null,
    acceptanceLedger: AcceptanceLedger | null,
    writebackResult: WritebackResult | null,
  ): Promise<FeatureLedger> => {
    const ledger: FeatureLedger = {
      runId,
      mode: "feature",
      mapSummary: { fileCount: repoMap.files.length, testFileCount: repoMap.testFiles.length },
      baselineSummary: summarizeBaseline(baseline),
      scopeReport,
      slices,
      sliceResults,
      verifyResult,
      acceptanceLedger,
      writebackResult,
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
    return finish("plan_only", [], null, null, null);
  }

  const sliceResults: SliceExecutionResult[] = [];
  let knownGoodPaths = new Set(
    baseline.tests.filter((t) => t.outcome === "passed").map((t) => t.nodeId.split("::")[0]),
  );
  let anyRegressionDetected = false;

  for (let i = 0; i < slices.length; i++) {
    const slice = slices[i];
    await markProgress(artifactRoot, runId, startedAt, "slice", { sliceIndex: i, totalSlices: slices.length });

    const sliceStartCommit = await currentHead(spec.targetDir);

    await backend.runPhase({
      cwd: spec.targetDir,
      model: spec.models.red,
      prompt: buildRedPrompt(slice),
      lockedPaths: [slice.implRelPath], // RED must not implement — now structurally enforced
    });
    await commitAll(spec.targetDir, `red: ${runId} slice ${i}`);

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
        refactorApplied: false,
        mutationScore: null,
      });
      return finish("red_gate_failed", sliceResults, null, null, null);
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

    if (!greenResult.passed) {
      sliceResults.push({
        slice,
        redOutcome: redResult.outcome,
        redGatePassed: true,
        redLint: redResult.lint,
        greenGatePassed: false,
        greenIterationsUsed: greenResult.iterationsUsed,
        greenEscalated: greenResult.escalated,
        diffGuardViolated: greenResult.diffGuardViolated,
        refactorApplied: false,
        mutationScore: null,
      });
      return finish("green_gate_exhausted", sliceResults, null, null, null);
    }

    await commitAll(spec.targetDir, `green: ${runId} slice ${i}`);

    const refactorResult = await attemptRefactor({
      backend,
      targetDir: spec.targetDir,
      venvDir: spec.venvDir,
      implRelPath: slice.implRelPath,
      testRelPath: slice.testRelPath,
      refactorModel: spec.models.green,
      buildPrompt: () => buildRefactorPrompt(slice),
    });

    if (refactorResult.applied) {
      await commitAll(spec.targetDir, `refactor: ${runId} slice ${i}`);
    }

    const checkpoint = await buildCheckpoint(spec.targetDir, i, sliceStartCommit);
    await writeArtifact(artifactRoot, runId, `checkpoint-slice-${i}`, checkpoint);

    const mutationScore = await computeMutationScore({
      workDir: spec.targetDir,
      venvDir: spec.venvDir,
      implRelPath: slice.implRelPath,
      functionName: slice.functionName,
      testRelPath: slice.testRelPath,
    });

    const constantMutant = mutationScore.results.find((r) => r.operator === "constant");
    if (constantMutant?.applied && constantMutant.survived === true) {
      sliceResults.push({
        slice,
        redOutcome: redResult.outcome,
        redGatePassed: true,
        redLint: redResult.lint,
        greenGatePassed: true,
        greenIterationsUsed: greenResult.iterationsUsed,
        greenEscalated: greenResult.escalated,
        diffGuardViolated: greenResult.diffGuardViolated,
        refactorApplied: refactorResult.applied,
        mutationScore,
      });
      return finish("mutation_gate_failed", sliceResults, null, null, null);
    }

    sliceResults.push({
      slice,
      redOutcome: redResult.outcome,
      redGatePassed: true,
      redLint: redResult.lint,
      greenGatePassed: true,
      greenIterationsUsed: greenResult.iterationsUsed,
      greenEscalated: greenResult.escalated,
      diffGuardViolated: greenResult.diffGuardViolated,
      refactorApplied: refactorResult.applied,
      mutationScore,
    });

    const postSliceScan = await runPytestVerbose(spec.venvDir, spec.targetDir);
    const postSliceFailingPaths = new Set(
      postSliceScan.tests
        .filter((t) => t.outcome === "failed" || t.outcome === "error")
        .map((t) => t.nodeId.split("::")[0]),
    );
    const postSlicePassingPaths = new Set(
      postSliceScan.tests.filter((t) => t.outcome === "passed").map((t) => t.nodeId.split("::")[0]),
    );
    if ([...knownGoodPaths].some((p) => postSliceFailingPaths.has(p))) {
      anyRegressionDetected = true;
    }
    knownGoodPaths = new Set([...knownGoodPaths, ...postSlicePassingPaths]);
  }

  if (anyRegressionDetected) {
    return finish("completed_with_regressions", sliceResults, null, null, null);
  }

  const touchedTestPaths = sliceResults.map((r) => r.slice.testRelPath);
  const verifyResult = await runVerifyLadder({
    venvDir: spec.venvDir,
    targetDir: spec.targetDir,
    touchedTestPaths,
    newTestPaths: touchedTestPaths,
    repoMap,
    scopeReport,
  });
  await writeArtifact(artifactRoot, runId, "verify", verifyResult);

  if (!verifyResult.passed) {
    return finish("verify_failed", sliceResults, verifyResult, null, null);
  }

  const acceptanceLedger = buildAcceptanceLedger(
    runId,
    sliceResults.map((r) => ({
      description: r.slice.description,
      implRelPath: r.slice.implRelPath,
      testRelPath: r.slice.testRelPath,
      redGatePassed: r.redGatePassed,
      greenGatePassed: r.greenGatePassed,
      refactorApplied: r.refactorApplied,
    })),
    verifyResult.passed,
  );
  await writeArtifact(artifactRoot, runId, "accept", acceptanceLedger);

  const writebackResult = await writeback({
    targetDir: spec.targetDir,
    runId,
    featureDescription: spec.featureDescription,
    slices: sliceResults.map((r) => ({
      description: r.slice.description,
      implRelPath: r.slice.implRelPath,
      testRelPath: r.slice.testRelPath,
      greenGatePassed: r.greenGatePassed,
      refactorApplied: r.refactorApplied,
      mutationScore: r.mutationScore?.score ?? 1,
    })),
    commit: spec.commit,
  });

  return finish("accepted", sliceResults, verifyResult, acceptanceLedger, writebackResult);
}
