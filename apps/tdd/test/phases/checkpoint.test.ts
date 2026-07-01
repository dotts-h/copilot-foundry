import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCommand } from "../../src/exec.js";
import { buildCheckpoint } from "../../src/phases/checkpoint.js";

describe("buildCheckpoint", () => {
  let dir: string;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("captures a patch of everything committed since fromCommit", async () => {
    dir = mkdtempSync(join(tmpdir(), "checkpoint-"));
    writeFileSync(join(dir, "a.py"), "x = 1\n");
    await runCommand("git", ["init", "-q"], { cwd: dir });
    await runCommand("git", ["config", "user.email", "test@example.com"], { cwd: dir });
    await runCommand("git", ["config", "user.name", "Test"], { cwd: dir });
    await runCommand("git", ["add", "-A"], { cwd: dir });
    await runCommand("git", ["commit", "-q", "-m", "seed"], { cwd: dir });
    const seedResult = await runCommand("git", ["rev-parse", "HEAD"], { cwd: dir });
    const fromCommit = seedResult.stdout.trim();

    writeFileSync(join(dir, "a.py"), "x = 2\n");
    await runCommand("git", ["add", "-A"], { cwd: dir });
    await runCommand("git", ["commit", "-q", "-m", "change"], { cwd: dir });

    const checkpoint = await buildCheckpoint(dir, 0, fromCommit);

    expect(checkpoint.sliceIndex).toBe(0);
    expect(checkpoint.fromCommit).toBe(fromCommit);
    expect(checkpoint.toCommit).not.toBe(fromCommit);
    expect(checkpoint.patch).toContain("-x = 1");
    expect(checkpoint.patch).toContain("+x = 2");
  });

  it("produces an empty patch when nothing changed since fromCommit", async () => {
    dir = mkdtempSync(join(tmpdir(), "checkpoint-"));
    writeFileSync(join(dir, "a.py"), "x = 1\n");
    await runCommand("git", ["init", "-q"], { cwd: dir });
    await runCommand("git", ["config", "user.email", "test@example.com"], { cwd: dir });
    await runCommand("git", ["config", "user.name", "Test"], { cwd: dir });
    await runCommand("git", ["add", "-A"], { cwd: dir });
    await runCommand("git", ["commit", "-q", "-m", "seed"], { cwd: dir });
    const seedResult = await runCommand("git", ["rev-parse", "HEAD"], { cwd: dir });
    const fromCommit = seedResult.stdout.trim();

    const checkpoint = await buildCheckpoint(dir, 1, fromCommit);
    expect(checkpoint.patch).toBe("");
    expect(checkpoint.toCommit).toBe(fromCommit);
  });
});
