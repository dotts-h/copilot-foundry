import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCommand } from "../src/exec.js";
import { handoffFromQa } from "../src/handoff.js";
import { ScriptedBackend, writeImpl } from "./helpers/fakeBackend.js";

const FIXTURE_VENV = join(process.cwd(), "fixtures", "add-kata", ".venv");

async function seedTargetRepo(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "handoff-"));
  writeFileSync(join(dir, "add_kata.py"), "def add(a, b):\n    raise NotImplementedError\n");
  await runCommand("git", ["init", "-q"], { cwd: dir });
  await runCommand("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  await runCommand("git", ["config", "user.name", "Test"], { cwd: dir });
  await runCommand("git", ["add", "-A"], { cwd: dir });
  await runCommand("git", ["commit", "-q", "-m", "seed"], { cwd: dir });
  return dir;
}

describe("handoffFromQa", () => {
  let targetDir: string;
  let artifactRoot: string;

  afterEach(() => {
    if (targetDir) rmSync(targetDir, { recursive: true, force: true });
    if (artifactRoot) rmSync(artifactRoot, { recursive: true, force: true });
  });

  it("translates a minimal qa handoff request into a valid feature run and drives it to completion", async () => {
    targetDir = await seedTargetRepo();
    artifactRoot = mkdtempSync(join(tmpdir(), "handoff-artifacts-"));

    const backend = new ScriptedBackend([
      () => ({
        resultText: JSON.stringify([
          {
            description: "add(a, b) returns a + b",
            implRelPath: "add_kata.py",
            testRelPath: "test_add_kata.py",
            functionName: "add",
          },
        ]),
      }),
      async (opts) => {
        writeFileSync(
          join(opts.cwd, "test_add_kata.py"),
          "from add_kata import add\n\ndef test_add():\n    assert add(2, 3) == 5\n    assert add(0, 0) == 0\n",
        );
      },
      async (opts) => writeImpl(opts.cwd, "add_kata.py", "def add(a, b):\n    return a + b\n"),
      async () => {},
    ]);

    const { ledger } = await handoffFromQa(
      { targetDir, venvDir: FIXTURE_VENV, featureDescription: "implement add" },
      backend,
      artifactRoot,
      "run-handoff-1",
    );

    expect(ledger.status).toBe("accepted");
    expect(ledger.sliceResults).toHaveLength(1);
  });

  it("rejects an empty featureDescription before any backend call, via the same validation runFeature uses", async () => {
    targetDir = await seedTargetRepo();
    artifactRoot = mkdtempSync(join(tmpdir(), "handoff-artifacts-"));
    const backend = new ScriptedBackend([() => ({ resultText: "[]" })]);

    await expect(
      handoffFromQa(
        { targetDir, venvDir: FIXTURE_VENV, featureDescription: "   " },
        backend,
        artifactRoot,
        "run-handoff-2",
      ),
    ).rejects.toThrow(/featureDescription/);
    expect(backend.calls).toHaveLength(0);
  });

  it("defaults commit to false when the request omits it", async () => {
    targetDir = await seedTargetRepo();
    artifactRoot = mkdtempSync(join(tmpdir(), "handoff-artifacts-"));

    const backend = new ScriptedBackend([
      () => ({
        resultText: JSON.stringify([
          {
            description: "add(a, b) returns a + b",
            implRelPath: "add_kata.py",
            testRelPath: "test_add_kata.py",
            functionName: "add",
          },
        ]),
      }),
      async (opts) => {
        writeFileSync(
          join(opts.cwd, "test_add_kata.py"),
          "from add_kata import add\n\ndef test_add():\n    assert add(2, 3) == 5\n    assert add(0, 0) == 0\n",
        );
      },
      async (opts) => writeImpl(opts.cwd, "add_kata.py", "def add(a, b):\n    return a + b\n"),
      async () => {},
    ]);

    const { ledger } = await handoffFromQa(
      { targetDir, venvDir: FIXTURE_VENV, featureDescription: "implement add" },
      backend,
      artifactRoot,
      "run-handoff-3",
    );

    expect(ledger.writebackResult?.committed).toBe(false);
  });
});
