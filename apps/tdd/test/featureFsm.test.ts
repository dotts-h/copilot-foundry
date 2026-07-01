import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCommand } from "../src/exec.js";
import { runFeature } from "../src/featureFsm.js";
import { DEFAULT_MODELS, type FeatureRunSpec } from "../src/types.js";
import { ScriptedBackend, writeImpl } from "./helpers/fakeBackend.js";

const FIXTURE_VENV = join(process.cwd(), "fixtures", "add-kata", ".venv");

async function seedTargetRepo(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "feature-fsm-"));
  writeFileSync(join(dir, "add_kata.py"), "def add(a, b):\n    raise NotImplementedError\n");
  await runCommand("git", ["init", "-q"], { cwd: dir });
  await runCommand("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  await runCommand("git", ["config", "user.name", "Test"], { cwd: dir });
  await runCommand("git", ["add", "-A"], { cwd: dir });
  await runCommand("git", ["commit", "-q", "-m", "seed"], { cwd: dir });
  return dir;
}

function baseSpec(overrides: Partial<FeatureRunSpec> = {}): FeatureRunSpec {
  return {
    mode: "feature",
    targetDir: "",
    venvDir: FIXTURE_VENV,
    scope: "repo",
    hitl: "auto",
    featureDescription: "implement add",
    models: DEFAULT_MODELS,
    maxRepairIterations: 3,
    ...overrides,
  };
}

describe("runFeature", () => {
  let targetDir: string;
  let artifactRoot: string;

  afterEach(() => {
    if (targetDir) rmSync(targetDir, { recursive: true, force: true });
    if (artifactRoot) rmSync(artifactRoot, { recursive: true, force: true });
  });

  it("runs map->baseline->scope->plan->RED->GREEN for a single planned slice end to end", async () => {
    targetDir = await seedTargetRepo();
    artifactRoot = mkdtempSync(join(tmpdir(), "feature-fsm-artifacts-"));

    const backend = new ScriptedBackend([
      () => ({
        resultText: JSON.stringify([
          { description: "add(a, b) returns a + b", implRelPath: "add_kata.py", testRelPath: "test_add_kata.py" },
        ]),
      }),
      async (opts) => {
        writeFileSync(
          join(opts.cwd, "test_add_kata.py"),
          "from add_kata import add\n\ndef test_add():\n    assert add(2, 3) == 5\n",
        );
      },
      async (opts) => writeImpl(opts.cwd, "add_kata.py", "def add(a, b):\n    return a + b\n"),
    ]);

    const ledger = await runFeature(baseSpec({ targetDir }), backend, artifactRoot, "run-feature-1");

    expect(ledger.status).toBe("completed");
    expect(ledger.slices).toHaveLength(1);
    expect(ledger.sliceResults).toHaveLength(1);
    expect(ledger.sliceResults[0].redGatePassed).toBe(true);
    expect(ledger.sliceResults[0].greenGatePassed).toBe(true);
    expect(ledger.mapSummary.fileCount).toBeGreaterThan(0);
  });

  it("stops at plan and does not execute any slice when hitl is plan-only", async () => {
    targetDir = await seedTargetRepo();
    artifactRoot = mkdtempSync(join(tmpdir(), "feature-fsm-artifacts-"));

    const backend = new ScriptedBackend([
      () => ({
        resultText: JSON.stringify([
          { description: "add(a, b) returns a + b", implRelPath: "add_kata.py", testRelPath: "test_add_kata.py" },
        ]),
      }),
    ]);

    const ledger = await runFeature(baseSpec({ targetDir, hitl: "plan-only" }), backend, artifactRoot, "run-plan-only");

    expect(ledger.status).toBe("plan_only");
    expect(ledger.sliceResults).toEqual([]);
    expect(backend.calls).toHaveLength(1);
  });

  it("stops the run and reports red_gate_failed when the RED phase produces an already-green test", async () => {
    targetDir = await seedTargetRepo();
    artifactRoot = mkdtempSync(join(tmpdir(), "feature-fsm-artifacts-"));
    writeFileSync(join(targetDir, "add_kata.py"), "def add(a, b):\n    return a + b\n");
    await runCommand("git", ["add", "-A"], { cwd: targetDir });
    await runCommand("git", ["commit", "-q", "-m", "already correct"], { cwd: targetDir });

    const backend = new ScriptedBackend([
      () => ({
        resultText: JSON.stringify([
          { description: "add(a, b) returns a + b", implRelPath: "add_kata.py", testRelPath: "test_add_kata.py" },
        ]),
      }),
      async (opts) => {
        writeFileSync(
          join(opts.cwd, "test_add_kata.py"),
          "from add_kata import add\n\ndef test_add():\n    assert add(2, 3) == 5\n",
        );
      },
    ]);

    const ledger = await runFeature(baseSpec({ targetDir }), backend, artifactRoot, "run-already-green");

    expect(ledger.status).toBe("red_gate_failed");
    expect(ledger.sliceResults[0].redOutcome).toBe("already_green");
  });

  it("reports green_gate_exhausted when the implementation never satisfies the test and escalation also fails", async () => {
    targetDir = await seedTargetRepo();
    artifactRoot = mkdtempSync(join(tmpdir(), "feature-fsm-artifacts-"));

    const backend = new ScriptedBackend([
      () => ({
        resultText: JSON.stringify([
          { description: "add(a, b) returns a + b", implRelPath: "add_kata.py", testRelPath: "test_add_kata.py" },
        ]),
      }),
      async (opts) => {
        writeFileSync(
          join(opts.cwd, "test_add_kata.py"),
          "from add_kata import add\n\ndef test_add():\n    assert add(2, 3) == 5\n",
        );
      },
      async (opts) => writeImpl(opts.cwd, "add_kata.py", "def add(a, b):\n    return a - b\n"),
    ]);

    const ledger = await runFeature(
      baseSpec({ targetDir, maxRepairIterations: 1 }),
      backend,
      artifactRoot,
      "run-green-exhausted",
    );

    expect(ledger.status).toBe("green_gate_exhausted");
    expect(ledger.sliceResults[0].greenGatePassed).toBe(false);
  });
});
