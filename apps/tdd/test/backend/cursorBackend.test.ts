import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CursorBackend } from "../../src/backend/cursorBackend.js";

const RUN_LIVE = process.env.RUN_CURSOR_E2E === "1";

describe.skipIf(!RUN_LIVE)("CursorBackend (live)", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cursor-backend-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("runs a phase against the real cursor-agent CLI and returns success + resultText", async () => {
    const backend = new CursorBackend();
    const result = await backend.runPhase({
      cwd: dir,
      model: "composer-2.5-fast",
      prompt: "Do not create, edit, or delete any files. Reply with exactly: PROBE_OK",
    });
    expect(result.success).toBe(true);
    expect(result.resultText).toContain("PROBE_OK");
    expect(result.durationMs).toBeGreaterThan(0);
  }, 60_000);
});
