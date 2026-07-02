import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCommand } from "../src/exec.js";
import { runFeature } from "../src/featureFsm.js";
import { DEFAULT_MODELS_BY_BACKEND, type FeatureRunSpec } from "../src/types.js";
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
    models: DEFAULT_MODELS_BY_BACKEND.claude,
    maxRepairIterations: 3,
    commit: false,
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

  it("runs map->baseline->scope->plan->RED->GREEN->REFACTOR->mutation->verify->accept->writeback for a single planned slice end to end", async () => {
    targetDir = await seedTargetRepo();
    artifactRoot = mkdtempSync(join(tmpdir(), "feature-fsm-artifacts-"));

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
      async (opts) => {
        await writeImpl(opts.cwd, "add_kata.py", "def add(a, b):\n    return a + b\n");
        const pycacheDir = join(opts.cwd, "__pycache__");
        mkdirSync(pycacheDir, { recursive: true });
        writeFileSync(join(pycacheDir, "add_kata.cpython-313.pyc"), "fake bytecode");
      },
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
    expect(ledger.sliceResults[0].mutationScore?.results.find((r) => r.operator === "constant")?.survived).toBe(
      false,
    );
    expect(ledger.writebackResult?.committed).toBe(false);
    expect(backend.calls[0].lockedPaths).toBeUndefined(); // plan
    expect(backend.calls[1].lockedPaths).toEqual(["add_kata.py"]); // RED locks impl
    expect(backend.calls[1].prompt).toContain("import it inside the new test function(s) instead");
    expect(backend.calls[2].lockedPaths).toEqual(["test_add_kata.py"]); // GREEN locks test

    expect(ledger.workspace.branchName).toBe("helm-tdd/run-feature-1");
    const show = await runCommand("git", ["show", "helm-tdd/run-feature-1:add_kata.py"], { cwd: targetDir });
    expect(show.stdout).toContain("return a + b");
    const untouched = readFileSync(join(targetDir, "add_kata.py"), "utf8");
    expect(untouched).toContain("NotImplementedError"); // user's checkout never mutated
    const list = await runCommand("git", ["worktree", "list", "--porcelain"], { cwd: targetDir });
    expect(list.stdout.match(/^worktree /gm)?.length).toBe(1); // worktree cleaned up

    const tree = await runCommand("git", ["ls-tree", "-r", "--name-only", "helm-tdd/run-feature-1"], {
      cwd: targetDir,
    });
    expect(tree.stdout).not.toContain("__pycache__"); // bytecode caches never committed onto the run branch
  });

  it("stops at plan and does not execute any slice when hitl is plan-only", async () => {
    targetDir = await seedTargetRepo();
    artifactRoot = mkdtempSync(join(tmpdir(), "feature-fsm-artifacts-"));

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
          {
            description: "add(a, b) returns a + b",
            implRelPath: "add_kata.py",
            testRelPath: "../../etc/passwd",
            functionName: "add",
          },
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
          {
            description: "add(a, b) returns a + b",
            implRelPath: "add_kata.py",
            testRelPath: "test_add_kata.py",
            functionName: "add",
          },
          {
            description: "subtract(a, b) returns a - b",
            implRelPath: "add_kata.py",
            testRelPath: "test_subtract_kata.py",
            functionName: "subtract",
          },
        ]),
      }),
      async (opts) => {
        writeFileSync(
          join(opts.cwd, "test_add_kata.py"),
          "from add_kata import add\n\ndef test_add():\n    assert add(2, 3) == 5\n    assert add(0, 0) == 0\n",
        );
      },
      async (opts) =>
        writeImpl(
          opts.cwd,
          "add_kata.py",
          "def add(a, b):\n    return a + b\n\n\ndef double(x):\n    return x * 2\n\n\ndef subtract(a, b):\n    raise NotImplementedError\n",
        ),
      async () => {},
      async (opts) => {
        writeFileSync(
          join(opts.cwd, "test_subtract_kata.py"),
          "from add_kata import subtract\n\ndef test_subtract():\n    assert subtract(5, 3) == 2\n    assert subtract(10, 4) == 6\n",
        );
      },
      async (opts) =>
        writeImpl(
          opts.cwd,
          "add_kata.py",
          "def add(a, b):\n    return a + b\n\n\ndef double(x):\n    return x * 3\n\n\ndef subtract(a, b):\n    return a - b\n",
        ),
      async () => {},
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

    writeFileSync(
      join(targetDir, "add_kata.py"),
      "def add(a, b):\n    raise NotImplementedError\n\n\ndef subtract(a, b):\n    raise NotImplementedError\n",
    );
    await runCommand("git", ["add", "-A"], { cwd: targetDir });
    await runCommand("git", ["commit", "-q", "-m", "seed subtract stub"], { cwd: targetDir });

    const backend = new ScriptedBackend([
      () => ({
        resultText: JSON.stringify([
          {
            description: "add(a, b) returns a + b",
            implRelPath: "add_kata.py",
            testRelPath: "test_add_kata.py",
            functionName: "add",
          },
          {
            description: "subtract(a, b) returns a - b",
            implRelPath: "add_kata.py",
            testRelPath: "test_subtract_kata.py",
            functionName: "subtract",
          },
        ]),
      }),
      async (opts) => {
        writeFileSync(
          join(opts.cwd, "test_add_kata.py"),
          "from add_kata import add\n\ndef test_add():\n    assert add(2, 3) == 5\n    assert add(0, 0) == 0\n",
        );
      },
      async (opts) =>
        writeImpl(
          opts.cwd,
          "add_kata.py",
          "def add(a, b):\n    return a + b\n\n\ndef subtract(a, b):\n    raise NotImplementedError\n",
        ),
      async () => {},
      async (opts) => {
        writeFileSync(
          join(opts.cwd, "test_subtract_kata.py"),
          "from add_kata import subtract\n\ndef test_subtract():\n    assert subtract(5, 3) == 2\n    assert subtract(10, 4) == 6\n",
        );
      },
      async (opts) =>
        writeImpl(
          opts.cwd,
          "add_kata.py",
          "def add(a, b):\n    return a - b\n\n\ndef subtract(a, b):\n    return a - b\n",
        ),
      async () => {},
    ]);

    const ledger = await runFeature(baseSpec({ targetDir }), backend, artifactRoot, "run-inter-slice-regression");

    expect(ledger.sliceResults).toHaveLength(2);
    expect(ledger.sliceResults[0].greenGatePassed).toBe(true);
    expect(ledger.sliceResults[1].greenGatePassed).toBe(true);
    expect(ledger.status).toBe("completed_with_regressions");
  });

  it("reports mutation_gate_failed when the constant mutant survives a weak, single-example test", async () => {
    targetDir = await seedTargetRepo();
    artifactRoot = mkdtempSync(join(tmpdir(), "feature-fsm-artifacts-"));

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
          "from add_kata import add\n\ndef test_add():\n    assert add(2, 3) == 5\n",
        );
      },
      async (opts) => writeImpl(opts.cwd, "add_kata.py", "def add(a, b):\n    return a + b\n"),
    ]);

    const ledger = await runFeature(baseSpec({ targetDir }), backend, artifactRoot, "run-mutation-gate-failed");

    expect(ledger.status).toBe("mutation_gate_failed");
    expect(ledger.sliceResults[0].greenGatePassed).toBe(true);
    expect(
      ledger.sliceResults[0].mutationScore?.results.find((r) => r.operator === "constant")?.survived,
    ).toBe(true);
  });
});
