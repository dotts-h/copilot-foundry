import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCommand } from "../src/exec.js";
import { createRunWorkspace, removeRunWorkspace } from "../src/runWorkspace.js";

async function seedRepo(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "ws-"));
  writeFileSync(join(dir, "a.py"), "x = 1\n");
  await runCommand("git", ["init", "-q"], { cwd: dir });
  await runCommand("git", ["config", "user.email", "t@e.c"], { cwd: dir });
  await runCommand("git", ["config", "user.name", "T"], { cwd: dir });
  await runCommand("git", ["add", "-A"], { cwd: dir });
  await runCommand("git", ["commit", "-q", "-m", "seed"], { cwd: dir });
  return dir;
}

describe("runWorkspace", () => {
  let dir: string;
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

  it("creates a worktree on branch helm-tdd/<runId> at HEAD and removes it cleanly", async () => {
    dir = await seedRepo();
    const ws = await createRunWorkspace(dir, "r1");
    expect(ws.branchName).toBe("helm-tdd/r1");
    expect(existsSync(join(ws.workDir, "a.py"))).toBe(true);
    // commits in the worktree land on the branch, not the user's checkout
    writeFileSync(join(ws.workDir, "b.py"), "y = 2\n");
    await runCommand("git", ["add", "-A"], { cwd: ws.workDir });
    await runCommand("git", ["commit", "-q", "-m", "in-ws"], { cwd: ws.workDir });
    expect(existsSync(join(dir, "b.py"))).toBe(false);
    await removeRunWorkspace(dir, ws.workDir);
    expect(existsSync(ws.workDir)).toBe(false);
    const branch = await runCommand("git", ["rev-parse", "--verify", "helm-tdd/r1"], { cwd: dir });
    expect(branch.exitCode).toBe(0); // branch survives worktree removal
    const list = await runCommand("git", ["worktree", "list", "--porcelain"], { cwd: dir });
    expect(list.stdout.match(/^worktree /gm)?.length).toBe(1); // only the main checkout remains
  });

  it("throws a clear error when targetDir is not a git repo with a commit", async () => {
    dir = mkdtempSync(join(tmpdir(), "ws-nogit-"));
    await expect(createRunWorkspace(dir, "r2")).rejects.toThrow(/git repository/);
  });
});
