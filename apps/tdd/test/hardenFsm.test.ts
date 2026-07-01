import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCommand } from "../src/exec.js";
import { runHardenSlice } from "../src/hardenFsm.js";
import { ScriptedBackend, writeImpl } from "./helpers/fakeBackend.js";

const FIXTURE_VENV = join(process.cwd(), "fixtures", "add-kata", ".venv");

async function seedLegacyRepo(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "harden-fsm-"));
  // A "legacy" off-by-one bug, no tests yet.
  writeFileSync(join(dir, "legacy_kata.py"), "def divide(a, b):\n    return a // b + 1\n");
  await runCommand("git", ["init", "-q"], { cwd: dir });
  await runCommand("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  await runCommand("git", ["config", "user.name", "Test"], { cwd: dir });
  await runCommand("git", ["add", "-A"], { cwd: dir });
  await runCommand("git", ["commit", "-q", "-m", "seed legacy"], { cwd: dir });
  return dir;
}

describe("runHardenSlice", () => {
  let dir: string;
  let artifactRoot: string;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    if (artifactRoot) rmSync(artifactRoot, { recursive: true, force: true });
  });

  it("characterizes current (buggy) behavior when the backend correctly captures it", async () => {
    dir = await seedLegacyRepo();
    artifactRoot = mkdtempSync(join(tmpdir(), "harden-fsm-artifacts-"));

    const backend = new ScriptedBackend([
      async (opts) => {
        writeImpl(
          opts.cwd,
          "test_legacy_kata.py",
          "from legacy_kata import divide\n\ndef test_divide_current_behavior():\n    assert divide(10, 2) == 6\n",
        );
      },
    ]);

    const ledger = await runHardenSlice(
      {
        targetDir: dir,
        venvDir: FIXTURE_VENV,
        model: "fake-harden",
        targetRelPath: "legacy_kata.py",
        functionName: "divide",
        testRelPath: "test_legacy_kata.py",
      },
      backend,
      artifactRoot,
      "run-harden-1",
    );

    expect(ledger.mode).toBe("harden");
    expect(ledger.characterizationOutcome).toBe("characterized");
    expect(ledger.characterized).toBe(true);
  });

  it("reports test_fails_immediately when the backend's characterization does not match actual behavior", async () => {
    dir = await seedLegacyRepo();
    artifactRoot = mkdtempSync(join(tmpdir(), "harden-fsm-artifacts-"));

    const backend = new ScriptedBackend([
      async (opts) => {
        writeImpl(
          opts.cwd,
          "test_legacy_kata.py",
          "from legacy_kata import divide\n\ndef test_divide_wrong():\n    assert divide(10, 2) == 5\n",
        );
      },
    ]);

    const ledger = await runHardenSlice(
      {
        targetDir: dir,
        venvDir: FIXTURE_VENV,
        model: "fake-harden",
        targetRelPath: "legacy_kata.py",
        functionName: "divide",
        testRelPath: "test_legacy_kata.py",
      },
      backend,
      artifactRoot,
      "run-harden-2",
    );

    expect(ledger.characterizationOutcome).toBe("test_fails_immediately");
    expect(ledger.characterized).toBe(false);
  });
});
