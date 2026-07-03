import { writeArtifact } from "./artifacts/vault.js";
import type { Backend, PhaseTelemetry } from "./backend/types.js";
import { runCommand } from "./exec.js";
import { attemptRefactor } from "./gates/refactorGate.js";
import { classifyRedOutcome, type RedGateResult, type RedOutcome } from "./gates/redGate.js";
import { runGreenWithRepair } from "./gates/greenGate.js";
import type { RedLintResult } from "./gates/redLinter.js";
import type { MutationScoreResult } from "./gates/mutationGate.js";
import { mapRepo, type FileSymbols, type RepoMap } from "./phases/map.js";
import { runBaseline, type BaselineReport } from "./phases/baseline.js";
import { computeScope, type ScopeReport } from "./phases/scope.js";
import { planSlices, type PlannedSlice } from "./phases/plan.js";
import { renderSymbols, SLICE_SYMBOLS_CAP } from "./phases/symbolRender.js";
import { buildCheckpoint } from "./phases/checkpoint.js";
import { runVerifyLadder, type VerifyResult } from "./phases/verify.js";
import { buildAcceptanceLedger, type AcceptanceLedger } from "./phases/accept.js";
import { writeback, type WritebackResult } from "./phases/writeback.js";
import { createRunWorkspace, removeRunWorkspace, scopeRelPathFromGitRoot } from "./runWorkspace.js";
import { writeRunState } from "./runStore.js";
import { resolveRunner } from "./runner/resolve.js";
import type { TargetRunner } from "./runner/types.js";
import { soundPaths } from "./soundPaths.js";
import { validateFeatureRunSpec, type FeatureRunSpec } from "./types.js";

export interface SlicePhaseTelemetry {
  red: PhaseTelemetry | null;
  green: PhaseTelemetry[];
  refactor: PhaseTelemetry | null;
}

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
  phaseTelemetry: SlicePhaseTelemetry;
}

export type FeatureRunStatus =
  | "accepted"
  | "verify_failed"
  | "mutation_gate_failed"
  | "mutation_gate_error"
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
  planTelemetry: PhaseTelemetry | null;
  totalCostUsd: number | null;
  totalDenials: number;
}

function summarizeBaseline(baseline: BaselineReport): { total: number; passed: number; failed: number } {
  return {
    total: baseline.tests.length,
    passed: baseline.tests.filter((t) => t.outcome === "passed").length,
    failed: baseline.tests.filter((t) => t.outcome === "failed" || t.outcome === "error").length,
  };
}

function collectPhaseTelemetry(telemetry: PhaseTelemetry | null | undefined): PhaseTelemetry[] {
  return telemetry ? [telemetry] : [];
}

function computeTotalCostUsd(
  planTelemetry: PhaseTelemetry | null,
  sliceResults: SliceExecutionResult[],
): number | null {
  const all: PhaseTelemetry[] = [...collectPhaseTelemetry(planTelemetry)];
  for (const slice of sliceResults) {
    all.push(...collectPhaseTelemetry(slice.phaseTelemetry.red));
    all.push(...slice.phaseTelemetry.green);
    all.push(...collectPhaseTelemetry(slice.phaseTelemetry.refactor));
  }
  let sum = 0;
  let anyCost = false;
  for (const t of all) {
    if (t.costUsd !== undefined) {
      sum += t.costUsd;
      anyCost = true;
    }
  }
  return anyCost ? sum : null;
}

function computeTotalDenials(planTelemetry: PhaseTelemetry | null, sliceResults: SliceExecutionResult[]): number {
  const all: PhaseTelemetry[] = [...collectPhaseTelemetry(planTelemetry)];
  for (const slice of sliceResults) {
    all.push(...collectPhaseTelemetry(slice.phaseTelemetry.red));
    all.push(...slice.phaseTelemetry.green);
    all.push(...collectPhaseTelemetry(slice.phaseTelemetry.refactor));
  }
  return all.reduce((acc, t) => acc + t.denials.length, 0);
}

async function writeSliceGateArtifacts(
  artifactRoot: string,
  runId: string,
  sliceIndex: number,
  redResult: RedGateResult,
  greenAttempts: Array<{ rawTestOutput: string }>,
): Promise<void> {
  await writeArtifact(artifactRoot, runId, `slice-${sliceIndex}-red-output`, {
    firstRun: redResult.rawRuns[0] ?? "",
    secondRun: redResult.rawRuns[1] ?? "",
  });
  await writeArtifact(
    artifactRoot,
    runId,
    `slice-${sliceIndex}-green-attempts`,
    greenAttempts.map((a, n) => ({ attempt: n + 1, rawTestOutput: a.rawTestOutput })),
  );
}

function targetExistsInImpl(symbols: FileSymbols, functionName: string): boolean {
  if (symbols.functions.some((f) => f.name === functionName)) return true;
  return symbols.classes.some((c) => c.methods.some((m) => m.name === functionName));
}

function listExistingTestNames(symbols: FileSymbols): string | undefined {
  const names = symbols.functions.filter((f) => f.name.startsWith("test_")).map((f) => f.name);
  if (names.length === 0) return undefined;
  if (names.length <= 40) return names.join(", ");
  return `${names.slice(0, 40).join(", ")}, …`;
}

function buildRedPrompt(slice: PlannedSlice, repoMap: RepoMap, runner: TargetRunner): string {
  const parts = [
    `Write ONLY a failing ${runner.testFrameworkName} test at ${slice.testRelPath} for this behavior: ${slice.description}. ` +
      `The implementation lives at ${slice.implRelPath} and does not yet satisfy this behavior. ` +
      "Include at least two assertions with different, non-trivially-related expected values (not just one " +
      "example) so the test actually triangulates the behavior and cannot be satisfied by a function that " +
      "always returns a single constant. " +
      runner.redPromptRules +
      "Do NOT implement or modify the implementation file. Do not create or modify any other file.",
  ];

  const implSymbols = renderSymbols(repoMap, [slice.implRelPath], SLICE_SYMBOLS_CAP);
  if (implSymbols) {
    parts.push(`Current symbols in the implementation module:\n${implSymbols}`);
  }

  const testSymbols = repoMap.symbols[slice.testRelPath];
  if (testSymbols) {
    const testNames = listExistingTestNames(testSymbols);
    if (testNames) {
      parts.push(`Existing tests in ${slice.testRelPath} (do not duplicate their names): ${testNames}`);
    }
  }

  const implEntry = repoMap.symbols[slice.implRelPath];
  if (implEntry) {
    if (targetExistsInImpl(implEntry, slice.functionName)) {
      parts.push(
        `The target function ${slice.functionName} already exists in ${slice.implRelPath} — your test drives a behavior change to it.`,
      );
    } else {
      parts.push(
        `The target function ${slice.functionName} does NOT exist yet in ${slice.implRelPath}${runner.missingSymbolRedNote}`,
      );
    }
  }

  return parts.join("\n\n");
}

function buildGreenPrompt(slice: PlannedSlice, repoMap: RepoMap, lastFailureOutput: string | undefined): string {
  const parts: string[] = [];
  const implSymbols = renderSymbols(repoMap, [slice.implRelPath], SLICE_SYMBOLS_CAP);
  if (implSymbols) {
    parts.push(`Current symbols in the implementation module:\n${implSymbols}`);
  }

  const base =
    `The test at ${slice.testRelPath} is currently failing. Make it pass with the minimal correct ` +
    `implementation in ${slice.implRelPath} for: ${slice.description}. Do NOT modify ${slice.testRelPath} ` +
    "under any circumstances -- it is locked and any attempt to edit it will be reverted and the slice will fail.";
  parts.push(base);

  if (lastFailureOutput !== undefined) {
    parts.push(`The previous attempt failed with:\n${lastFailureOutput}`);
  }

  return parts.join("\n\n");
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
  await runCommand(
    "git",
    ["add", "-A", "--", ".", ":(exclude)__pycache__", ":(exclude)*.pyc", ":(exclude)node_modules"],
    {
      cwd: dir,
      timeoutMs: 30_000,
    },
  );
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

  const runner = await resolveRunner({
    targetDir: spec.targetDir,
    venvDir: spec.venvDir,
    language: spec.language,
  });
  const scopeRelPath = await scopeRelPathFromGitRoot(spec.targetDir);
  const workspace = await createRunWorkspace(spec.targetDir, runId);
  const workDir = workspace.workDir;
  try {
    await runner.ensureEnv(workDir);

    const startedAt = new Date().toISOString();
    await markProgress(artifactRoot, runId, startedAt, "map", workspace.branchName);

    const repoMap: RepoMap = await mapRepo(workDir, runner, scopeRelPath);
    await writeArtifact(artifactRoot, runId, "map", repoMap);

    await markProgress(artifactRoot, runId, startedAt, "baseline", workspace.branchName);
    const baseline = await runBaseline(runner, workDir);
    await writeArtifact(artifactRoot, runId, "baseline", baseline);

    await markProgress(artifactRoot, runId, startedAt, "scope", workspace.branchName);
    const scopeReport = computeScope(repoMap, spec.targetHint, spec.scope);
    await writeArtifact(artifactRoot, runId, "scope", scopeReport);

    await markProgress(artifactRoot, runId, startedAt, "plan", workspace.branchName);
    const { slices, telemetry: planTelemetry } = await planSlices({
      backend,
      model: spec.models.plan,
      targetDir: workDir,
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
        workspace: { branchName: workspace.branchName, baseCommit: workspace.baseCommit },
        planTelemetry,
        totalCostUsd: computeTotalCostUsd(planTelemetry, sliceResults),
        totalDenials: computeTotalDenials(planTelemetry, sliceResults),
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
    let knownGoodPaths = soundPaths(baseline.tests);
    let anyRegressionDetected = false;

    for (let i = 0; i < slices.length; i++) {
      const slice = slices[i];
      await markProgress(artifactRoot, runId, startedAt, "slice", workspace.branchName, {
        sliceIndex: i,
        totalSlices: slices.length,
      });

      const sliceStartCommit = await currentHead(workDir);

      const redPhase = await backend.runPhase({
        cwd: workDir,
        model: spec.models.red,
        prompt: buildRedPrompt(slice, repoMap, runner),
        lockedPaths: [slice.implRelPath], // RED must not implement — now structurally enforced
      });
      await commitAll(workDir, `red: ${runId} slice ${i}`);

      const redResult = await classifyRedOutcome({
        targetDir: workDir,
        runner,
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
          phaseTelemetry: { red: redPhase.telemetry, green: [], refactor: null },
        });
        await writeSliceGateArtifacts(artifactRoot, runId, i, redResult, []);
        return await finish("red_gate_failed", sliceResults, null, null, null);
      }

      const greenResult = await runGreenWithRepair({
        backend,
        targetDir: workDir,
        runner,
        testRelPath: slice.testRelPath,
        greenModel: spec.models.green,
        escalationModel: spec.models.escalation,
        maxIterations: spec.maxRepairIterations,
        // Symbols reflect the module as mapped at run start; RED may have added test symbols since then.
        buildPrompt: (lastFailure) => buildGreenPrompt(slice, repoMap, lastFailure),
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
          phaseTelemetry: {
            red: redPhase.telemetry,
            green: greenResult.attempts.map((a) => a.telemetry),
            refactor: null,
          },
        });
        await writeSliceGateArtifacts(artifactRoot, runId, i, redResult, greenResult.attempts);
        return await finish("green_gate_exhausted", sliceResults, null, null, null);
      }

      await commitAll(workDir, `green: ${runId} slice ${i}`);

      const refactorResult = await attemptRefactor({
        backend,
        targetDir: workDir,
        runner,
        venvDir: spec.venvDir,
        implRelPath: slice.implRelPath,
        testRelPath: slice.testRelPath,
        refactorModel: spec.models.green,
        buildPrompt: () => buildRefactorPrompt(slice),
      });

      if (refactorResult.applied) {
        await commitAll(workDir, `refactor: ${runId} slice ${i}`);
      }

      const checkpoint = await buildCheckpoint(workDir, i, sliceStartCommit);
      await writeArtifact(artifactRoot, runId, `checkpoint-slice-${i}`, checkpoint);

      const mutationScore = await runner.computeMutationScore({
        workDir,
        implRelPath: slice.implRelPath,
        functionName: slice.functionName,
        testRelPath: slice.testRelPath,
      });

      const slicePhaseTelemetry: SlicePhaseTelemetry = {
        red: redPhase.telemetry,
        green: greenResult.attempts.map((a) => a.telemetry),
        refactor: refactorResult.telemetry,
      };

      const constantMutant = mutationScore.results.find((r) => r.operator === "constant");
      if (constantMutant?.outcome === "error") {
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
          phaseTelemetry: slicePhaseTelemetry,
        });
        await writeSliceGateArtifacts(artifactRoot, runId, i, redResult, greenResult.attempts);
        return await finish("mutation_gate_error", sliceResults, null, null, null);
      }
      if (constantMutant?.outcome === "applied" && constantMutant.survived === true) {
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
          phaseTelemetry: slicePhaseTelemetry,
        });
        await writeSliceGateArtifacts(artifactRoot, runId, i, redResult, greenResult.attempts);
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
        phaseTelemetry: slicePhaseTelemetry,
      });
      await writeSliceGateArtifacts(artifactRoot, runId, i, redResult, greenResult.attempts);

      const postSliceScan = await runner.runTestsVerbose(workDir);
      const postSliceFailingPaths = new Set(
        postSliceScan.tests
          .filter((t) => t.outcome === "failed" || t.outcome === "error")
          .map((t) => t.nodeId.split("::")[0]),
      );
      if ([...knownGoodPaths].some((p) => postSliceFailingPaths.has(p))) {
        anyRegressionDetected = true;
      }
      knownGoodPaths = new Set([...knownGoodPaths, ...soundPaths(postSliceScan.tests)]);
    }

    if (anyRegressionDetected) {
      return await finish("completed_with_regressions", sliceResults, null, null, null);
    }

    const touchedTestPaths = sliceResults.map((r) => r.slice.testRelPath);
    const verifyResult = await runVerifyLadder({
      runner,
      targetDir: workDir,
      touchedTestPaths,
      newTestPaths: touchedTestPaths,
      repoMap,
      scopeReport,
      baseline,
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
