import { writeArtifact } from "./artifacts/vault.js";
import type { Backend } from "./backend/types.js";
import { runCommand } from "./exec.js";
import { attemptRefactor, type RefactorAttemptResult } from "./gates/refactorGate.js";
import { classifyRedOutcome, type RedOutcome } from "./gates/redGate.js";
import { runGreenWithRepair } from "./gates/greenGate.js";
import type { RedLintResult } from "./gates/redLinter.js";
import { computeMutationScore, type MutationScoreResult } from "./gates/mutationGate.js";
import { mapRepo, type RepoMap } from "./phases/map.js";
import type { BaselineReport } from "./phases/baseline.js";
import { computeScope, type ScopeReport } from "./phases/scope.js";
import { planSlices, type PlannedSlice } from "./phases/plan.js";
import { buildCheckpoint } from "./phases/checkpoint.js";
import { runVerifyLadder, type VerifyResult } from "./phases/verify.js";
import { buildAcceptanceLedger, type AcceptanceLedger } from "./phases/accept.js";
import { writeback, type WritebackResult } from "./phases/writeback.js";
import { createRunWorkspace, removeRunWorkspace } from "./runWorkspace.js";
import { writeRunState } from "./runStore.js";
import { createToolchain } from "./toolchain.js";
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
  workspace: { branchName: string; baseCommit: string };
}

function summarizeBaseline(baseline: BaselineReport): { total: number; passed: number; failed: number } {
  return {
    total: baseline.tests.length,
    passed: baseline.tests.filter((t) => t.outcome === "passed").length,
    failed: baseline.tests.filter((t) => t.outcome === "failed" || t.outcome === "error").length,
  };
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
  // Phase agents may run python/pytest in the worktree; never commit bytecode caches onto the run branch.
  await runCommand("git", ["add", "-A", "--", ".", ":(exclude)__pycache__", ":(exclude)*.pyc"], {
    cwd: dir,
    timeoutMs: 30_000,
  });
  const result = await runCommand("git", ["commit", "-q", "-m", message], { cwd: dir, timeoutMs: 30_000 });
  // With excluded pycache present but untracked, git reports "nothing added to commit" instead of
  // "nothing to commit" -- both mean there was nothing real to commit and must stay non-fatal.
  if (result.exitCode !== 0 && !/nothing (added )?to commit/.test(result.stdout + result.stderr)) {
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
  branchName: string,
  extra?: { sliceIndex?: number; totalSlices?: number },
): Promise<void> {
  await writeRunState(artifactRoot, runId, {
    status: "running",
    progress: { phase, branchName, ...extra },
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

  const workspace = await createRunWorkspace(spec.targetDir, runId);
  const workDir = workspace.workDir;
  try {
    const toolchain = await createToolchain(spec.language, spec.venvDir, workDir);

    const startedAt = new Date().toISOString();
    await markProgress(artifactRoot, runId, startedAt, "map", workspace.branchName);

    const repoMap: RepoMap = await mapRepo(workDir, spec.language);
    await writeArtifact(artifactRoot, runId, "map", repoMap);

    await markProgress(artifactRoot, runId, startedAt, "baseline", workspace.branchName);
    const { tests: baselineTests } = await toolchain.runVerbose(workDir);
    const baseline: BaselineReport = { tests: baselineTests };
    await writeArtifact(artifactRoot, runId, "baseline", baseline);

    await markProgress(artifactRoot, runId, startedAt, "scope", workspace.branchName);
    const scopeReport = computeScope(repoMap, spec.targetHint, spec.scope, spec.language);
    await writeArtifact(artifactRoot, runId, "scope", scopeReport);

    await markProgress(artifactRoot, runId, startedAt, "plan", workspace.branchName);
    const slices = await planSlices({
      backend,
      model: spec.models.plan,
      targetDir: workDir,
      featureDescription: spec.featureDescription,
      repoMap,
      scopeReport,
      planNouns: toolchain.planNouns,
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
        workspace: { branchName: workspace.branchName, baseCommit: workspace.baseCommit },
      };
      await writeArtifact(artifactRoot, runId, "featureLedger", ledger);
      await writeRunState(artifactRoot, runId, {
        status: "done",
        progress: { phase: status, totalSlices: slices.length, branchName: workspace.branchName },
        startedAt,
        updatedAt: ledger.completedAt,
      });
      return ledger;
    };

    if (spec.hitl === "plan-only") {
      return await finish("plan_only", [], null, null, null);
    }

    const sliceResults: SliceExecutionResult[] = [];
    let knownGoodPaths = new Set(
      baseline.tests.filter((t) => t.outcome === "passed").map((t) => t.nodeId.split("::")[0]),
    );
    let anyRegressionDetected = false;

    for (let i = 0; i < slices.length; i++) {
      const slice = slices[i];
      await markProgress(artifactRoot, runId, startedAt, "slice", workspace.branchName, {
        sliceIndex: i,
        totalSlices: slices.length,
      });

      const sliceStartCommit = await currentHead(workDir);

      await backend.runPhase({
        cwd: workDir,
        model: spec.models.red,
        prompt: toolchain.buildRedPrompt(slice),
        lockedPaths: [slice.implRelPath], // RED must not implement — now structurally enforced
      });
      await commitAll(workDir, `red: ${runId} slice ${i}`);

      const redResult = await classifyRedOutcome({
        targetDir: workDir,
        toolchain,
        testRelPath: slice.testRelPath,
        functionName: slice.functionName,
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
        return await finish("red_gate_failed", sliceResults, null, null, null);
      }

      const greenResult = await runGreenWithRepair({
        backend,
        targetDir: workDir,
        toolchain,
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
        return await finish("green_gate_exhausted", sliceResults, null, null, null);
      }

      await commitAll(workDir, `green: ${runId} slice ${i}`);

      const refactorResult: RefactorAttemptResult = toolchain.supportsRefactor
        ? await attemptRefactor({
            backend,
            targetDir: workDir,
            venvDir: spec.venvDir as string, // supportsRefactor is python-only in M6; validateFeatureRunSpec guarantees this
            toolchain,
            implRelPath: slice.implRelPath,
            testRelPath: slice.testRelPath,
            refactorModel: spec.models.green,
            buildPrompt: () => buildRefactorPrompt(slice),
          })
        : { attempted: false, applied: false, before: null, after: null, reason: "refactor not supported for this language" };

      if (refactorResult.applied) {
        await commitAll(workDir, `refactor: ${runId} slice ${i}`);
      }

      const checkpoint = await buildCheckpoint(workDir, i, sliceStartCommit);
      await writeArtifact(artifactRoot, runId, `checkpoint-slice-${i}`, checkpoint);

      const mutationScore: MutationScoreResult = toolchain.supportsMutationGate
        ? await computeMutationScore({
            workDir,
            venvDir: spec.venvDir as string, // supportsMutationGate is python-only in M6; validateFeatureRunSpec guarantees this
            implRelPath: slice.implRelPath,
            functionName: slice.functionName,
            testRelPath: slice.testRelPath,
          })
        : {
            results: [{ operator: "constant", applied: false, survived: null }],
            killedCount: 0,
            survivedCount: 0,
            attemptedCount: 0,
            score: 1,
          };

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
        return await finish("mutation_gate_failed", sliceResults, null, null, null);
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

      const postSliceScan = await toolchain.runVerbose(workDir);
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
      return await finish("completed_with_regressions", sliceResults, null, null, null);
    }

    const touchedTestPaths = sliceResults.map((r) => r.slice.testRelPath);
    const verifyResult = await runVerifyLadder({
      toolchain,
      targetDir: workDir,
      touchedTestPaths,
      newTestPaths: touchedTestPaths,
      repoMap,
      scopeReport,
    });
    await writeArtifact(artifactRoot, runId, "verify", verifyResult);

    if (!verifyResult.passed) {
      return await finish("verify_failed", sliceResults, verifyResult, null, null);
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
      targetDir: workDir,
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

    return await finish("accepted", sliceResults, verifyResult, acceptanceLedger, writebackResult);
  } finally {
    await removeRunWorkspace(spec.targetDir, workspace.workDir);
  }
}
