import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { runCommand } from "./exec.js";

export async function gitRootOf(dir: string): Promise<string> {
  const result = await runCommand("git", ["rev-parse", "--show-toplevel"], { cwd: dir, timeoutMs: 15_000 });
  if (result.exitCode !== 0) {
    throw new Error(`gitRootOf: "${dir}" is not a git repository: ${result.stderr.trim()}`);
  }
  return result.stdout.trim();
}

export async function scopeRelPathFromGitRoot(targetDir: string): Promise<string> {
  const gitRoot = await gitRootOf(targetDir);
  const rel = relative(gitRoot, resolve(targetDir));
  return rel === "." ? "" : rel;
}

export interface RunWorkspace {
  workDir: string;
  branchName: string;
  baseCommit: string;
}

export async function createRunWorkspace(targetDir: string, runId: string): Promise<RunWorkspace> {
  const head = await runCommand("git", ["rev-parse", "HEAD"], { cwd: targetDir, timeoutMs: 15_000 });
  if (head.exitCode !== 0) {
    throw new Error(
      `createRunWorkspace: "${targetDir}" is not a git repository with at least one commit: ${head.stderr.trim()}`,
    );
  }
  const baseCommit = head.stdout.trim();
  const branchName = `helm-tdd/${runId}`;
  const parent = await mkdtemp(join(tmpdir(), "helm-tdd-ws-"));
  const workDir = join(parent, "repo");
  const added = await runCommand("git", ["worktree", "add", "-b", branchName, workDir, "HEAD"], {
    cwd: targetDir,
    timeoutMs: 30_000,
  });
  if (added.exitCode !== 0) {
    await rm(parent, { recursive: true, force: true });
    throw new Error(`createRunWorkspace: git worktree add failed: ${added.stdout}${added.stderr}`);
  }
  return { workDir, branchName, baseCommit };
}

export async function removeRunWorkspace(targetDir: string, workDir: string): Promise<void> {
  await runCommand("git", ["worktree", "remove", "--force", workDir], { cwd: targetDir, timeoutMs: 30_000 });
  await rm(dirname(workDir), { recursive: true, force: true });
}
