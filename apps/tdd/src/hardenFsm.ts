import { writeArtifact } from "./artifacts/vault.js";
import type { Backend } from "./backend/types.js";
import { runCommand } from "./exec.js";
import { classifyCharacterizationOutcome, type CharacterizationOutcome } from "./gates/characterizationGate.js";

export interface HardenSliceSpec {
  targetDir: string;
  venvDir: string;
  model: string;
  targetRelPath: string;
  functionName: string;
  testRelPath: string;
}

export interface HardenSliceLedger {
  runId: string;
  mode: "harden";
  characterizationOutcome: CharacterizationOutcome;
  characterized: boolean;
  completedAt: string;
}

function buildCharacterizationPrompt(spec: HardenSliceSpec): string {
  return (
    `Write a pytest characterization test at ${spec.testRelPath} for the function ${spec.functionName} ` +
    `in ${spec.targetRelPath}. Do NOT change ${spec.targetRelPath}. Call ${spec.functionName} with a ` +
    "representative input and assert on whatever it ACTUALLY currently returns (even if that looks " +
    "wrong or buggy) -- the goal is to record its present behavior as a safety net, not to fix it."
  );
}

export async function runHardenSlice(
  spec: HardenSliceSpec,
  backend: Backend,
  artifactRoot: string,
  runId: string,
): Promise<HardenSliceLedger> {
  await backend.runPhase({
    cwd: spec.targetDir,
    model: spec.model,
    prompt: buildCharacterizationPrompt(spec),
  });

  await runCommand("git", ["add", "-A"], { cwd: spec.targetDir, timeoutMs: 30_000 });
  await runCommand("git", ["commit", "-q", "-m", `characterize: ${runId}`], {
    cwd: spec.targetDir,
    timeoutMs: 30_000,
  });

  const characterization = await classifyCharacterizationOutcome({
    targetDir: spec.targetDir,
    venvDir: spec.venvDir,
    testRelPath: spec.testRelPath,
  });

  const ledger: HardenSliceLedger = {
    runId,
    mode: "harden",
    characterizationOutcome: characterization.outcome,
    characterized: characterization.passed,
    completedAt: new Date().toISOString(),
  };

  await writeArtifact(artifactRoot, runId, "hardenLedger", ledger);
  return ledger;
}
