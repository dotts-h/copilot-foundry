import type { Backend } from "./backend.js";
import { checkDiffGuard, revertPaths } from "./diffGuard.js";
import { runCommand } from "./exec.js";
import type { LanguageAdapter } from "./languages/adapter.js";

export interface GenericSliceSpec {
  targetDir: string;
  language: LanguageAdapter;
  redModel: string;
  greenModel: string;
  testRelPath: string;
  redPrompt: string;
  greenPrompt: string;
}

export interface GenericSliceLedger {
  runId: string;
  language: string;
  redSuccess: boolean;
  redGatePassed: boolean;
  greenSuccess: boolean;
  greenGatePassed: boolean;
  diffGuardViolated: boolean;
  completedAt: string;
}

export async function runGenericSlice(
  spec: GenericSliceSpec,
  backend: Backend,
  runId: string,
): Promise<GenericSliceLedger> {
  const redResult = await backend.runPhase({
    cwd: spec.targetDir,
    model: spec.redModel,
    prompt: spec.redPrompt,
  });

  await runCommand("git", ["add", "-A"], { cwd: spec.targetDir, timeoutMs: 30_000 });
  await runCommand("git", ["commit", "-q", "-m", `red: ${runId}`], { cwd: spec.targetDir, timeoutMs: 30_000 });

  const redRun = await spec.language.runTests(spec.targetDir, spec.testRelPath);
  const redGatePassed = redRun.exitCode !== 0;

  const greenResult = await backend.runPhase({
    cwd: spec.targetDir,
    model: spec.greenModel,
    prompt: spec.greenPrompt,
  });

  const diffGuard = await checkDiffGuard(spec.targetDir, [spec.testRelPath]);
  if (diffGuard.violated) {
    await revertPaths(spec.targetDir, diffGuard.offendingPaths);
  }

  const greenRun = await spec.language.runTests(spec.targetDir, spec.testRelPath);
  const greenGatePassed = greenRun.exitCode === 0;

  return {
    runId,
    language: spec.language.name,
    redSuccess: redResult.success,
    redGatePassed,
    greenSuccess: greenResult.success,
    greenGatePassed,
    diffGuardViolated: diffGuard.violated,
    completedAt: new Date().toISOString(),
  };
}
