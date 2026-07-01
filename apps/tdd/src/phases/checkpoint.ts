import { runCommand } from "../exec.js";

export interface CheckpointPatch {
  sliceIndex: number;
  fromCommit: string;
  toCommit: string;
  patch: string;
}

export async function buildCheckpoint(
  targetDir: string,
  sliceIndex: number,
  fromCommit: string,
): Promise<CheckpointPatch> {
  const headResult = await runCommand("git", ["rev-parse", "HEAD"], { cwd: targetDir, timeoutMs: 15_000 });
  const toCommit = headResult.stdout.trim();

  const diffResult = await runCommand("git", ["diff", `${fromCommit}..${toCommit}`], {
    cwd: targetDir,
    timeoutMs: 15_000,
  });

  return { sliceIndex, fromCommit, toCommit, patch: diffResult.stdout };
}
