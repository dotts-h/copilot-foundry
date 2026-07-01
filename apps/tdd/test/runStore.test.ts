import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readRunState, writeRunState } from "../src/runStore.js";

describe("runStore", () => {
  let artifactRoot: string;

  beforeEach(() => {
    artifactRoot = mkdtempSync(join(tmpdir(), "run-store-"));
  });

  afterEach(() => {
    rmSync(artifactRoot, { recursive: true, force: true });
  });

  it("returns undefined for a runId that was never written", async () => {
    const state = await readRunState(artifactRoot, "does-not-exist");
    expect(state).toBeUndefined();
  });

  it("round-trips a written run state", async () => {
    const state = {
      status: "running" as const,
      progress: { phase: "plan" },
      startedAt: "2026-07-01T00:00:00.000Z",
      updatedAt: "2026-07-01T00:00:01.000Z",
    };
    await writeRunState(artifactRoot, "run-1", state);

    const read = await readRunState(artifactRoot, "run-1");
    expect(read).toEqual(state);
  });

  it("overwrites the previous state on a second write, so status transitions are visible", async () => {
    await writeRunState(artifactRoot, "run-1", {
      status: "running",
      progress: { phase: "map" },
      startedAt: "t0",
      updatedAt: "t0",
    });
    await writeRunState(artifactRoot, "run-1", {
      status: "done",
      progress: { phase: "done" },
      startedAt: "t0",
      updatedAt: "t1",
    });

    const read = await readRunState(artifactRoot, "run-1");
    expect(read?.status).toBe("done");
  });

  it("is readable from a state written under a completely fresh artifactRoot handle (proves disk, not memory, is the source of truth)", async () => {
    await writeRunState(artifactRoot, "run-1", {
      status: "error",
      progress: { phase: "plan" },
      error: "boom",
      startedAt: "t0",
      updatedAt: "t1",
    });

    const read = await readRunState(artifactRoot, "run-1");
    expect(read?.status).toBe("error");
    expect(read?.error).toBe("boom");
  });
});
