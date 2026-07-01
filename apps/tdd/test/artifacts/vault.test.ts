import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { artifactPath, readArtifact, writeArtifact } from "../../src/artifacts/vault.js";

describe("artifact vault", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "vault-test-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("computes the artifact path under artifacts/tdd/<runId>/<name>.json", () => {
    const p = artifactPath(root, "run-123", "ledger");
    expect(p).toBe(join(root, "artifacts", "tdd", "run-123", "ledger.json"));
  });

  it("writes JSON to disk and returns the path", async () => {
    const path = await writeArtifact(root, "run-123", "ledger", { ok: true, n: 3 });
    expect(path).toBe(join(root, "artifacts", "tdd", "run-123", "ledger.json"));
    const raw = JSON.parse(readFileSync(path, "utf8"));
    expect(raw).toEqual({ ok: true, n: 3 });
  });

  it("creates intermediate directories that do not yet exist", async () => {
    await writeArtifact(root, "brand-new-run", "state", { step: "red" });
    const raw = JSON.parse(
      readFileSync(join(root, "artifacts", "tdd", "brand-new-run", "state.json"), "utf8"),
    );
    expect(raw).toEqual({ step: "red" });
  });

  it("reads back exactly what was written", async () => {
    await writeArtifact(root, "run-456", "ledger", { a: [1, 2, 3], b: "x" });
    const data = await readArtifact<{ a: number[]; b: string }>(root, "run-456", "ledger");
    expect(data).toEqual({ a: [1, 2, 3], b: "x" });
  });

  it("rejects reading an artifact that does not exist", async () => {
    await expect(readArtifact(root, "no-such-run", "ledger")).rejects.toThrow();
  });
});
