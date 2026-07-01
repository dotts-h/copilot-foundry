import { existsSync } from "node:fs";
import { join } from "node:path";
import { writeArtifact } from "./artifacts/vault.js";
import type { Backend } from "./backend/types.js";
import { runCommand } from "./exec.js";
import { checkDiffGuard, revertPaths } from "./gates/diffGuard.js";
import { writeLeashConfig } from "./gates/leash.js";
import { runPytest } from "./pythonRunner.js";
import type { RunSpec, SliceLedger } from "./types.js";

const PYTEST_ALL_PASSED = 0;
const PYTEST_TESTS_FAILED = 1;

export async function runSlice(
  spec: RunSpec,
  backend: Backend,
  artifactRoot: string,
  runId: string,
): Promise<SliceLedger> {
  await writeLeashConfig(spec.targetDir, [spec.testRelPath]);

  const redResult = await backend.runPhase({
    cwd: spec.targetDir,
    model: spec.redModel,
    prompt: spec.redPrompt,
  });

  await runCommand("git", ["add", "-A"], { cwd: spec.targetDir });
  await runCommand("git", ["commit", "-q", "-m", `red: ${runId}`], { cwd: spec.targetDir });

  const testFileExists = existsSync(join(spec.targetDir, spec.testRelPath));
  const redPytest = await runPytest(spec.venvDir, spec.targetDir, spec.testRelPath);
  const redGatePassed = testFileExists && redPytest.exitCode === PYTEST_TESTS_FAILED;

  const greenResult = await backend.runPhase({
    cwd: spec.targetDir,
    model: spec.greenModel,
    prompt: spec.greenPrompt,
  });

  const diffGuard = await checkDiffGuard(spec.targetDir, [spec.testRelPath]);
  if (diffGuard.violated) {
    await revertPaths(spec.targetDir, diffGuard.offendingPaths);
  }

  const greenPytest = await runPytest(spec.venvDir, spec.targetDir, spec.testRelPath);
  const greenGatePassed = greenPytest.exitCode === PYTEST_ALL_PASSED;

  const ledger: SliceLedger = {
    runId,
    redSuccess: redResult.success,
    redGatePassed,
    greenSuccess: greenResult.success,
    greenGatePassed,
    diffGuardViolated: diffGuard.violated,
    diffGuardOffendingPaths: diffGuard.offendingPaths,
    completedAt: new Date().toISOString(),
  };

  await writeArtifact(artifactRoot, runId, "ledger", ledger);

  return ledger;
}
