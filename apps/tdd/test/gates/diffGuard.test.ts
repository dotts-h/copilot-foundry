import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCommand } from "../../src/exec.js";
import { checkDiffGuard, revertPaths } from "../../src/gates/diffGuard.js";

async function initRepo(dir: string) {
  await runCommand("git", ["init", "-q"], { cwd: dir });
  await runCommand("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  await runCommand("git", ["config", "user.name", "Test"], { cwd: dir });
  writeFileSync(join(dir, "locked.txt"), "LOCKED_ORIGINAL\n");
  writeFileSync(join(dir, "unlocked.txt"), "UNLOCKED_ORIGINAL\n");
  await runCommand("git", ["add", "-A"], { cwd: dir });
  await runCommand("git", ["commit", "-q", "-m", "init"], { cwd: dir });
}

describe("diff guard", () => {
  let dir: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "diffguard-test-"));
    await initRepo(dir);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("reports no violation when the locked path is untouched", async () => {
    writeFileSync(join(dir, "unlocked.txt"), "changed\n");
    const result = await checkDiffGuard(dir, ["locked.txt"]);
    expect(result).toEqual({ violated: false, offendingPaths: [] });
  });

  it("reports a violation when a locked tracked file is modified", async () => {
    writeFileSync(join(dir, "locked.txt"), "HACKED\n");
    const result = await checkDiffGuard(dir, ["locked.txt"]);
    expect(result.violated).toBe(true);
    expect(result.offendingPaths).toEqual(["locked.txt"]);
  });

  it("reports a violation when a locked file is deleted", async () => {
    await runCommand("rm", [join(dir, "locked.txt")]);
    const result = await checkDiffGuard(dir, ["locked.txt"]);
    expect(result.violated).toBe(true);
    expect(result.offendingPaths).toEqual(["locked.txt"]);
  });

  it("revertPaths restores a modified locked file to its committed content", async () => {
    writeFileSync(join(dir, "locked.txt"), "HACKED\n");
    await revertPaths(dir, ["locked.txt"]);
    const after = await runCommand("cat", [join(dir, "locked.txt")]);
    expect(after.stdout).toBe("LOCKED_ORIGINAL\n");
    const result = await checkDiffGuard(dir, ["locked.txt"]);
    expect(result.violated).toBe(false);
  });
});
