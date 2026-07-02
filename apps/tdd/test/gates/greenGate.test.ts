import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCommand } from "../../src/exec.js";
import { runGreenWithRepair } from "../../src/gates/greenGate.js";
import { createPythonRunner } from "../../src/runner/pythonRunner.js";
import { ScriptedBackend, writeImpl } from "../helpers/fakeBackend.js";

const FIXTURE_VENV = join(process.cwd(), "fixtures", "add-kata", ".venv");
const runner = createPythonRunner(FIXTURE_VENV);

async function seedRepo(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "green-gate-"));
  writeFileSync(join(dir, "add_kata.py"), "def add(a, b):\n    raise NotImplementedError\n");
  writeFileSync(join(dir, "test_add_kata.py"), "from add_kata import add\n\ndef test_add():\n    assert add(2, 3) == 5\n");
  await runCommand("git", ["init", "-q"], { cwd: dir });
  await runCommand("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  await runCommand("git", ["config", "user.name", "Test"], { cwd: dir });
  await runCommand("git", ["add", "-A"], { cwd: dir });
  await runCommand("git", ["commit", "-q", "-m", "seed"], { cwd: dir });
  return dir;
}

describe("runGreenWithRepair", () => {
  let dir: string;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("passes on the first iteration when the backend gets it right immediately", async () => {
    dir = await seedRepo();
    const backend = new ScriptedBackend([
      async (opts) => writeImpl(opts.cwd, "add_kata.py", "def add(a, b):\n    return a + b\n"),
    ]);

    const result = await runGreenWithRepair({
      backend,
      targetDir: dir,
      runner,
      testRelPath: "test_add_kata.py",
      greenModel: "fake-green",
      escalationModel: "fake-escalation",
      maxIterations: 3,
      buildPrompt: () => "implement add",
    });

    expect(result.passed).toBe(true);
    expect(result.iterationsUsed).toBe(1);
    expect(result.escalated).toBe(false);
    expect(backend.calls).toHaveLength(1);
  });

  it("retries on failure and succeeds within maxIterations without escalating", async () => {
    dir = await seedRepo();
    const backend = new ScriptedBackend([
      async (opts) => writeImpl(opts.cwd, "add_kata.py", "def add(a, b):\n    return a - b\n"),
      async (opts) => writeImpl(opts.cwd, "add_kata.py", "def add(a, b):\n    return a + b\n"),
    ]);

    const result = await runGreenWithRepair({
      backend,
      targetDir: dir,
      runner,
      testRelPath: "test_add_kata.py",
      greenModel: "fake-green",
      escalationModel: "fake-escalation",
      maxIterations: 3,
      buildPrompt: () => "implement add",
    });

    expect(result.passed).toBe(true);
    expect(result.iterationsUsed).toBe(2);
    expect(result.failureHistory).toHaveLength(1);
    expect(backend.calls).toHaveLength(2);
  });

  it("escalates to the escalation model after exhausting maxIterations, and can still succeed there", async () => {
    dir = await seedRepo();
    const backend = new ScriptedBackend([
      async (opts) => writeImpl(opts.cwd, "add_kata.py", "def add(a, b):\n    return 0\n"),
      async (opts) => writeImpl(opts.cwd, "add_kata.py", "def add(a, b):\n    return 0\n"),
      async (opts) => writeImpl(opts.cwd, "add_kata.py", "def add(a, b):\n    return a + b\n"),
    ]);

    const result = await runGreenWithRepair({
      backend,
      targetDir: dir,
      runner,
      testRelPath: "test_add_kata.py",
      greenModel: "fake-green",
      escalationModel: "fake-escalation",
      maxIterations: 2,
      buildPrompt: () => "implement add",
    });

    expect(result.passed).toBe(true);
    expect(result.escalated).toBe(true);
    expect(result.iterationsUsed).toBe(3);
    expect(backend.calls[2].model).toBe("fake-escalation");
  });

  it("fails the gate when even escalation is exhausted", async () => {
    dir = await seedRepo();
    const backend = new ScriptedBackend([
      async (opts) => writeImpl(opts.cwd, "add_kata.py", "def add(a, b):\n    return 0\n"),
    ]);

    const result = await runGreenWithRepair({
      backend,
      targetDir: dir,
      runner,
      testRelPath: "test_add_kata.py",
      greenModel: "fake-green",
      escalationModel: "fake-escalation",
      maxIterations: 1,
      buildPrompt: () => "implement add",
    });

    expect(result.passed).toBe(false);
    expect(result.escalated).toBe(true);
    expect(result.failureHistory.length).toBeGreaterThan(0);
  });

  it("reverts and flags a diff-guard violation when the backend edits the locked test file, but still judges pass/fail on the reverted state", async () => {
    dir = await seedRepo();
    const backend = new ScriptedBackend([
      async (opts) => {
        await writeImpl(opts.cwd, "add_kata.py", "def add(a, b):\n    return a + b\n");
        await writeImpl(opts.cwd, "test_add_kata.py", "def test_add():\n    assert True\n");
      },
    ]);

    const result = await runGreenWithRepair({
      backend,
      targetDir: dir,
      runner,
      testRelPath: "test_add_kata.py",
      greenModel: "fake-green",
      escalationModel: "fake-escalation",
      maxIterations: 2,
      buildPrompt: () => "implement add",
    });

    expect(result.diffGuardViolated).toBe(true);
    expect(result.diffGuardOffendingPaths).toContain("test_add_kata.py");
    expect(result.passed).toBe(true);
    expect(result.iterationsUsed).toBe(1);
  });
});
