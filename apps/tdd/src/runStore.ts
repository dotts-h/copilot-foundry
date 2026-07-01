import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export type RunStatus = "running" | "done" | "error";

export interface RunProgress {
  phase: string;
  sliceIndex?: number;
  totalSlices?: number;
}

export interface RunState {
  status: RunStatus;
  progress: RunProgress;
  error?: string;
  startedAt: string;
  updatedAt: string;
}

function runStatePath(artifactRoot: string, runId: string): string {
  return join(artifactRoot, "artifacts", "tdd", runId, "run-state.json");
}

export async function writeRunState(artifactRoot: string, runId: string, state: RunState): Promise<void> {
  const path = runStatePath(artifactRoot, runId);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(state, null, 2));
}

export async function readRunState(artifactRoot: string, runId: string): Promise<RunState | undefined> {
  try {
    const raw = await readFile(runStatePath(artifactRoot, runId), "utf8");
    return JSON.parse(raw) as RunState;
  } catch {
    return undefined;
  }
}
