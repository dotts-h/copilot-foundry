import { existsSync } from "node:fs";
import { join } from "node:path";
import { writeArtifact } from "./artifacts/vault.js";
import { writeLeashConfig } from "./backend/cursorLeash.js";
import type { Backend } from "./backend/types.js";
import { runCommand } from "./exec.js";
import { checkDiffGuard, revertPaths } from "./gates/diffGuard.js";
import { createPythonRunner } from "./runner/pythonRunner.js";
import type { RunSpec, SliceLedger } from "./types.js";

export async function runSlice(
  spec: RunSpec,
  backend: Backend,
  artifactRoot: string,
  runId: string,
): Promise<SliceLedger> {
  const runner = createPythonRunner(spec.venvDir);

  await writeLeashConfig(spec.targetDir, [spec.testRelPath]);

  const redResult = await backend.runPhase({
    cwd: spec.targetDir,
    model: spec.redModel,
    prompt: spec.redPrompt,
  });

  await runCommand("git", ["add", "-A"], { cwd: spec.targetDir });
  await runCommand("git", ["commit", "-q", "-m", `red: ${runId}`], { cwd: spec.targetDir });

  const testFileExists = existsSync(join(spec.targetDir, spec.testRelPath));
  const redPytest = await runner.runTests(spec.targetDir, spec.testRelPath);
  const redGatePassed = testFileExists && runner.classifyRun(redPytest) === "failed";

  const greenResult = await backend.runPhase({
    cwd: spec.targetDir,
    model: spec.greenModel,
    prompt: spec.greenPrompt,
  });

  const diffGuard = await checkDiffGuard(spec.targetDir, [spec.testRelPath]);
  if (diffGuard.violated) {
    await revertPaths(spec.targetDir, diffGuard.offendingPaths);
  }

  const greenPytest = await runner.runTests(spec.targetDir, spec.testRelPath);
  const greenGatePassed = runner.classifyRun(greenPytest) === "passed";

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
