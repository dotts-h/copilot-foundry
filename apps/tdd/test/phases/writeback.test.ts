import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCommand } from "../../src/exec.js";
import { writeback, type WritebackInputSlice } from "../../src/phases/writeback.js";

const SLICE: WritebackInputSlice = {
  description: "add(a, b) returns a + b",
  implRelPath: "add_kata.py",
  testRelPath: "test_add_kata.py",
  greenGatePassed: true,
  refactorApplied: true,
  mutationScore: 0.75,
};

async function seedGitRepo(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "writeback-"));
  writeFileSync(join(dir, "add_kata.py"), "def add(a, b):\n    return a + b\n");
  await runCommand("git", ["init", "-q"], { cwd: dir });
  await runCommand("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  await runCommand("git", ["config", "user.name", "Test"], { cwd: dir });
  await runCommand("git", ["add", "-A"], { cwd: dir });
  await runCommand("git", ["commit", "-q", "-m", "seed"], { cwd: dir });
  return dir;
}

describe("writeback", () => {
  let dir: string;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("writes a memory markdown file summarizing the feature and its slices", async () => {
    dir = await seedGitRepo();

    const result = await writeback({
      targetDir: dir,
      runId: "run-1",
      featureDescription: "add string utilities",
      slices: [SLICE],
      commit: false,
    });

    expect(existsSync(result.memoryFilePath)).toBe(true);
    const content = readFileSync(result.memoryFilePath, "utf8");
    expect(content).toContain("run-1");
    expect(content).toContain("add string utilities");
    expect(content).toContain(SLICE.description);
    expect(content).toContain("75%");
  });

  it("does NOT commit the memory file when commit is false (dry-run)", async () => {
    dir = await seedGitRepo();

    await writeback({
      targetDir: dir,
      runId: "run-2",
      featureDescription: "add string utilities",
      slices: [SLICE],
      commit: false,
    });

    const status = await runCommand("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: dir });
    expect(status.stdout).toContain("memory/run-2.md");
  });

  it("commits the memory file when commit is true", async () => {
    dir = await seedGitRepo();

    const result = await writeback({
      targetDir: dir,
      runId: "run-3",
      featureDescription: "add string utilities",
      slices: [SLICE],
      commit: true,
    });

    expect(result.committed).toBe(true);
    const status = await runCommand("git", ["status", "--porcelain"], { cwd: dir });
    expect(status.stdout.trim()).toBe("");
    const log = await runCommand("git", ["log", "--oneline", "-1"], { cwd: dir });
    expect(log.stdout).toContain("writeback: run-3");
  });
});
