import { checkDiffGuard, revertPaths } from "./diffGuard.js";
import type { Backend } from "../backend/types.js";
import type { TestToolchain } from "../toolchain.js";

export interface GreenGateOptions {
  backend: Backend;
  targetDir: string;
  toolchain: TestToolchain;
  testRelPath: string;
  greenModel: string;
  escalationModel: string;
  maxIterations: number;
  buildPrompt: (lastFailureOutput: string | undefined) => string;
}

export interface GreenGateResult {
  passed: boolean;
  iterationsUsed: number;
  escalated: boolean;
  diffGuardViolated: boolean;
  diffGuardOffendingPaths: string[];
  failureHistory: string[];
}

async function attempt(
  opts: GreenGateOptions,
  model: string,
  lastFailure: string | undefined,
): Promise<{ passed: boolean; diffGuardViolated: boolean; diffGuardOffendingPaths: string[]; rawOutput: string }> {
  await opts.backend.runPhase({
    cwd: opts.targetDir,
    model,
    prompt: opts.buildPrompt(lastFailure),
    lockedPaths: [opts.testRelPath],
  });

  const guard = await checkDiffGuard(opts.targetDir, [opts.testRelPath]);
  if (guard.violated) {
    await revertPaths(opts.targetDir, guard.offendingPaths);
  }

  const scoped = await opts.toolchain.runScoped(opts.targetDir, opts.testRelPath);
  return {
    passed: scoped.verdict === "passed",
    diffGuardViolated: guard.violated,
    diffGuardOffendingPaths: guard.offendingPaths,
    rawOutput: scoped.raw,
  };
}

export async function runGreenWithRepair(opts: GreenGateOptions): Promise<GreenGateResult> {
  const failureHistory: string[] = [];
  let diffGuardViolated = false;
  let diffGuardOffendingPaths: string[] = [];
  let lastFailure: string | undefined;

  for (let iteration = 1; iteration <= opts.maxIterations; iteration++) {
    const result = await attempt(opts, opts.greenModel, lastFailure);
    diffGuardViolated ||= result.diffGuardViolated;
    if (result.diffGuardViolated) diffGuardOffendingPaths = result.diffGuardOffendingPaths;

    if (result.passed) {
      return {
        passed: true,
        iterationsUsed: iteration,
        escalated: false,
        diffGuardViolated,
        diffGuardOffendingPaths,
        failureHistory,
      };
    }

    lastFailure = result.rawOutput;
    failureHistory.push(lastFailure);
  }

  const escalationResult = await attempt(opts, opts.escalationModel, lastFailure);
  diffGuardViolated ||= escalationResult.diffGuardViolated;
  if (escalationResult.diffGuardViolated) diffGuardOffendingPaths = escalationResult.diffGuardOffendingPaths;

  if (escalationResult.passed) {
    return {
      passed: true,
      iterationsUsed: opts.maxIterations + 1,
      escalated: true,
      diffGuardViolated,
      diffGuardOffendingPaths,
      failureHistory,
    };
  }

  failureHistory.push(escalationResult.rawOutput);
  return {
    passed: false,
    iterationsUsed: opts.maxIterations + 1,
    escalated: true,
    diffGuardViolated,
    diffGuardOffendingPaths,
    failureHistory,
  };
}
