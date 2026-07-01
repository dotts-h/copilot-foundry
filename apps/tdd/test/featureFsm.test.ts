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

    expect(ledger.status).toBe("accepted");
    expect(ledger.slices).toHaveLength(1);
    expect(ledger.sliceResults).toHaveLength(1);
    expect(ledger.sliceResults[0].redGatePassed).toBe(true);
    expect(ledger.sliceResults[0].greenGatePassed).toBe(true);
    expect(ledger.mapSummary.fileCount).toBeGreaterThan(0);
    expect(ledger.verifyResult?.passed).toBe(true);
    expect(ledger.acceptanceLedger?.overallAccepted).toBe(true);
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

  it("rejects before any RED/GREEN backend call when a planned slice path is unsafe", async () => {
    targetDir = await seedTargetRepo();
    artifactRoot = mkdtempSync(join(tmpdir(), "feature-fsm-artifacts-"));

    const backend = new ScriptedBackend([
      () => ({
        resultText: JSON.stringify([
          { description: "add(a, b) returns a + b", implRelPath: "add_kata.py", testRelPath: "../../etc/passwd" },
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

    await expect(runFeature(baseSpec({ targetDir }), backend, artifactRoot, "run-unsafe-path")).rejects.toThrow(
      /not a safe repo-relative path/,
    );
    expect(backend.calls).toHaveLength(1);
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

  it("reports completed_with_regressions when a later slice's GREEN implementation breaks an already-passing baseline test, even though both slices' own gates pass", async () => {
    targetDir = await seedTargetRepo();
    artifactRoot = mkdtempSync(join(tmpdir(), "feature-fsm-artifacts-"));

    // Extend the seeded repo with a second, already-implemented-and-tested function
    // ("double") before the run starts, so it is captured as passing in the baseline
    // taken at the top of runFeature -- and a stub for a third function ("subtract")
    // that slice 2 will implement.
    writeFileSync(
      join(targetDir, "add_kata.py"),
      "def add(a, b):\n    raise NotImplementedError\n\n\ndef double(x):\n    return x * 2\n\n\ndef subtract(a, b):\n    raise NotImplementedError\n",
    );
    writeFileSync(
      join(targetDir, "test_double_kata.py"),
      "from add_kata import double\n\ndef test_double():\n    assert double(3) == 6\n",
    );
    await runCommand("git", ["add", "-A"], { cwd: targetDir });
    await runCommand("git", ["commit", "-q", "-m", "seed double"], { cwd: targetDir });

    const backend = new ScriptedBackend([
      () => ({
        resultText: JSON.stringify([
          { description: "add(a, b) returns a + b", implRelPath: "add_kata.py", testRelPath: "test_add_kata.py" },
          {
            description: "subtract(a, b) returns a - b",
            implRelPath: "add_kata.py",
            testRelPath: "test_subtract_kata.py",
          },
        ]),
      }),
      async (opts) => {
        writeFileSync(
          join(opts.cwd, "test_add_kata.py"),
          "from add_kata import add\n\ndef test_add():\n    assert add(2, 3) == 5\n",
        );
      },
      async (opts) =>
        writeImpl(
          opts.cwd,
          "add_kata.py",
          "def add(a, b):\n    return a + b\n\n\ndef double(x):\n    return x * 2\n\n\ndef subtract(a, b):\n    raise NotImplementedError\n",
        ),
      async () => {}, // REFACTOR1 no-op: nothing needs cleaning up
      async (opts) => {
        writeFileSync(
          join(opts.cwd, "test_subtract_kata.py"),
          "from add_kata import subtract\n\ndef test_subtract():\n    assert subtract(5, 3) == 2\n",
        );
      },
      // Slice 2's GREEN correctly implements subtract (and leaves add alone), but
      // silently breaks the already-passing "double" function -- a regression that
      // neither this slice's own gate (scoped to test_subtract_kata.py) nor RED's
      // baseline check (run before this write happened) can see.
      async (opts) =>
        writeImpl(
          opts.cwd,
          "add_kata.py",
          "def add(a, b):\n    return a + b\n\n\ndef double(x):\n    return x * 3\n\n\ndef subtract(a, b):\n    return a - b\n",
        ),
      async () => {}, // REFACTOR2 no-op: nothing needs cleaning up
    ]);

    const ledger = await runFeature(baseSpec({ targetDir }), backend, artifactRoot, "run-regression");

    expect(ledger.sliceResults).toHaveLength(2);
    expect(ledger.sliceResults[0].greenGatePassed).toBe(true);
    expect(ledger.sliceResults[1].greenGatePassed).toBe(true);
    expect(ledger.status).toBe("completed_with_regressions");
  });

  it("reports completed_with_regressions when slice 2's GREEN implementation breaks slice 1's own newly-authored, already-committed test", async () => {
    targetDir = await seedTargetRepo();
    artifactRoot = mkdtempSync(join(tmpdir(), "feature-fsm-artifacts-"));

    // Give add_kata.py a stub for the second slice's function up front, so slice 2's
    // RED test fails with a genuine assertion failure (NotImplementedError) rather than
    // an ImportError.
    writeFileSync(
      join(targetDir, "add_kata.py"),
      "def add(a, b):\n    raise NotImplementedError\n\n\ndef subtract(a, b):\n    raise NotImplementedError\n",
    );
    await runCommand("git", ["add", "-A"], { cwd: targetDir });
    await runCommand("git", ["commit", "-q", "-m", "seed subtract stub"], { cwd: targetDir });

    const backend = new ScriptedBackend([
      () => ({
        resultText: JSON.stringify([
          { description: "add(a, b) returns a + b", implRelPath: "add_kata.py", testRelPath: "test_add_kata.py" },
          {
            description: "subtract(a, b) returns a - b",
            implRelPath: "add_kata.py",
            testRelPath: "test_subtract_kata.py",
          },
        ]),
      }),
      async (opts) => {
        writeFileSync(
          join(opts.cwd, "test_add_kata.py"),
          "from add_kata import add\n\ndef test_add():\n    assert add(2, 3) == 5\n",
        );
      },
      // Slice 1's GREEN correctly implements add and leaves the subtract stub intact.
      // This test now passes and gets committed -- it is slice 1's own newly-authored,
      // now-known-good test, not a pre-existing baseline test.
      async (opts) =>
        writeImpl(
          opts.cwd,
          "add_kata.py",
          "def add(a, b):\n    return a + b\n\n\ndef subtract(a, b):\n    raise NotImplementedError\n",
        ),
      async () => {}, // REFACTOR1 no-op: nothing needs cleaning up
      async (opts) => {
        writeFileSync(
          join(opts.cwd, "test_subtract_kata.py"),
          "from add_kata import subtract\n\ndef test_subtract():\n    assert subtract(5, 3) == 2\n",
        );
      },
      // Slice 2's GREEN correctly implements subtract (its own gate, scoped to
      // test_subtract_kata.py, passes) but silently breaks add along the way --
      // regressing slice 1's already-committed, already-passing test.
      async (opts) =>
        writeImpl(
          opts.cwd,
          "add_kata.py",
          "def add(a, b):\n    return a - b\n\n\ndef subtract(a, b):\n    return a - b\n",
        ),
      async () => {}, // REFACTOR2 no-op: nothing needs cleaning up
    ]);

    const ledger = await runFeature(baseSpec({ targetDir }), backend, artifactRoot, "run-inter-slice-regression");

    expect(ledger.sliceResults).toHaveLength(2);
    expect(ledger.sliceResults[0].greenGatePassed).toBe(true);
    expect(ledger.sliceResults[1].greenGatePassed).toBe(true);
    expect(ledger.status).toBe("completed_with_regressions");
  });
});
