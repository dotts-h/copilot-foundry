import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { BaselineReport } from "../../src/phases/baseline.js";
import { runVerifyLadder } from "../../src/phases/verify.js";
import { createPythonRunner } from "../../src/runner/pythonRunner.js";
import type { TargetRunner } from "../../src/runner/types.js";
import type { RepoMap } from "../../src/phases/map.js";
import type { ScopeReport } from "../../src/phases/scope.js";

const FIXTURE_VENV = join(process.cwd(), "fixtures", "add-kata", ".venv");
const runner = createPythonRunner(FIXTURE_VENV);

function allPassingBaseline(nodeIds: string[]): BaselineReport {
  return { tests: nodeIds.map((nodeId) => ({ nodeId, outcome: "passed" as const })) };
}

describe("runVerifyLadder", () => {
  let dir: string;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("passes every level when all tests are green", async () => {
    dir = mkdtempSync(join(tmpdir(), "verify-ladder-"));
    writeFileSync(join(dir, "test_a.py"), "def test_a():\n    assert True\n");
    writeFileSync(join(dir, "test_b.py"), "def test_b():\n    assert True\n");

    const repoMap: RepoMap = {
      files: ["test_a.py", "test_b.py"],
      testFiles: ["test_a.py", "test_b.py"],
      imports: {},
      symbols: {},
    };
    const scopeReport: ScopeReport = { inScope: ["test_a.py", "test_b.py"], reason: "test" };

    const result = await runVerifyLadder({
      runner,
      targetDir: dir,
      touchedTestPaths: ["test_a.py"],
      newTestPaths: ["test_a.py"],
      repoMap,
      scopeReport,
      baseline: allPassingBaseline(["test_a.py::test_a", "test_b.py::test_b"]),
    });

    expect(result.passed).toBe(true);
    expect(result.levels.map((l) => l.level)).toEqual(["focused", "spec", "impacted-subgraph", "full-suite"]);
    expect(result.levels.every((l) => l.passed)).toBe(true);
  });

  it("stops at the first failing level and reports it", async () => {
    dir = mkdtempSync(join(tmpdir(), "verify-ladder-"));
    writeFileSync(join(dir, "test_a.py"), "def test_a():\n    assert True\n");
    writeFileSync(join(dir, "test_b.py"), "def test_b():\n    assert False\n");

    const repoMap: RepoMap = {
      files: ["test_a.py", "test_b.py"],
      testFiles: ["test_a.py", "test_b.py"],
      imports: {},
      symbols: {},
    };
    const scopeReport: ScopeReport = { inScope: ["test_a.py", "test_b.py"], reason: "test" };

    const result = await runVerifyLadder({
      runner,
      targetDir: dir,
      touchedTestPaths: ["test_a.py"],
      newTestPaths: ["test_a.py"],
      repoMap,
      scopeReport,
      baseline: allPassingBaseline(["test_a.py::test_a"]),
    });

    expect(result.passed).toBe(false);
    expect(result.failedLevel).toBe("impacted-subgraph");
    expect(result.levels.map((l) => l.level)).toEqual(["focused", "spec", "impacted-subgraph"]);
  });

  it("neutralizes a target repo's ini addopts so its coverage floor cannot fail the ladder", async () => {
    dir = mkdtempSync(join(tmpdir(), "verify-ladder-"));
    writeFileSync(
      join(dir, "pytest.ini"),
      "[pytest]\naddopts = --cov=foo --cov-report=term-missing --cov-fail-under=70\n",
    );
    writeFileSync(join(dir, "test_a.py"), "def test_a():\n    assert True\n");

    const repoMap: RepoMap = { files: ["test_a.py"], testFiles: ["test_a.py"], imports: {}, symbols: {} };
    const scopeReport: ScopeReport = { inScope: ["test_a.py"], reason: "test" };

    const result = await runVerifyLadder({
      runner,
      targetDir: dir,
      touchedTestPaths: ["test_a.py"],
      newTestPaths: ["test_a.py"],
      repoMap,
      scopeReport,
      baseline: allPassingBaseline(["test_a.py::test_a"]),
    });

    expect(result.passed).toBe(true);
    expect(result.levels.every((l) => l.passed)).toBe(true);
  });

  it("falls back to touchedTestPaths for impacted-subgraph when no in-scope test files are tracked", async () => {
    dir = mkdtempSync(join(tmpdir(), "verify-ladder-"));
    writeFileSync(join(dir, "test_a.py"), "def test_a():\n    assert True\n");

    const repoMap: RepoMap = { files: ["test_a.py"], testFiles: [], imports: {}, symbols: {} };
    const scopeReport: ScopeReport = { inScope: [], reason: "test" };

    const result = await runVerifyLadder({
      runner,
      targetDir: dir,
      touchedTestPaths: ["test_a.py"],
      newTestPaths: ["test_a.py"],
      repoMap,
      scopeReport,
      baseline: allPassingBaseline(["test_a.py::test_a"]),
    });

    expect(result.passed).toBe(true);
  });

  it("stops at static-gates when a stub runner returns a failing gate", async () => {
    dir = mkdtempSync(join(tmpdir(), "verify-ladder-"));
    writeFileSync(join(dir, "test_a.py"), "def test_a():\n    assert True\n");

    const repoMap: RepoMap = { files: ["test_a.py"], testFiles: ["test_a.py"], imports: {}, symbols: {} };
    const scopeReport: ScopeReport = { inScope: ["test_a.py"], reason: "test" };

    const stubRunner: TargetRunner = {
      ...runner,
      async runStaticGates(_workDir) {
        return [{ name: "tsc", passed: false, raw: "error TS1234: type mismatch" }];
      },
    };

    const result = await runVerifyLadder({
      runner: stubRunner,
      targetDir: dir,
      touchedTestPaths: ["test_a.py"],
      newTestPaths: ["test_a.py"],
      repoMap,
      scopeReport,
      baseline: allPassingBaseline(["test_a.py::test_a"]),
    });

    expect(result.passed).toBe(false);
    expect(result.failedLevel).toBe("static-gates");
    expect(result.levels.map((l) => l.level)).toEqual([
      "focused",
      "spec",
      "impacted-subgraph",
      "full-suite",
      "static-gates",
    ]);
    expect(result.levels.at(-1)?.passed).toBe(false);
  });

  it("passes full-suite when a baseline mixed path still fails", async () => {
    dir = mkdtempSync(join(tmpdir(), "verify-ladder-"));
    writeFileSync(
      join(dir, "test_mixed.py"),
      "def test_ok():\n    assert True\n\n\ndef test_broken():\n    assert False\n",
    );
    writeFileSync(join(dir, "test_new.py"), "def test_new():\n    assert True\n");

    const repoMap: RepoMap = {
      files: ["test_mixed.py", "test_new.py"],
      testFiles: ["test_mixed.py", "test_new.py"],
      imports: {},
      symbols: {},
    };
    const scopeReport: ScopeReport = { inScope: ["test_new.py"], reason: "test" };

    const result = await runVerifyLadder({
      runner,
      targetDir: dir,
      touchedTestPaths: ["test_new.py"],
      newTestPaths: ["test_new.py"],
      repoMap,
      scopeReport,
      baseline: {
        tests: [
          { nodeId: "test_mixed.py::test_ok", outcome: "passed" },
          { nodeId: "test_mixed.py::test_broken", outcome: "failed" },
          { nodeId: "test_new.py::test_new", outcome: "passed" },
        ],
      },
    });

    expect(result.passed).toBe(true);
    expect(result.levels.find((l) => l.level === "full-suite")?.passed).toBe(true);
  });

  it("fails full-suite when a baseline-sound path newly fails", async () => {
    dir = mkdtempSync(join(tmpdir(), "verify-ladder-"));
    writeFileSync(join(dir, "test_sound.py"), "def test_a():\n    assert True\n");
    writeFileSync(join(dir, "test_touched.py"), "def test_touched():\n    assert True\n");

    const repoMap: RepoMap = {
      files: ["test_sound.py", "test_touched.py"],
      testFiles: ["test_sound.py", "test_touched.py"],
      imports: {},
      symbols: {},
    };
    const scopeReport: ScopeReport = { inScope: ["test_touched.py"], reason: "test" };

    const stubRunner: TargetRunner = {
      ...runner,
      async runTestsVerbose(_workDir) {
        return {
          exitCode: 1,
          tests: [
            { nodeId: "test_sound.py::test_a", outcome: "failed" },
            { nodeId: "test_touched.py::test_touched", outcome: "passed" },
          ],
        };
      },
    };

    const result = await runVerifyLadder({
      runner: stubRunner,
      targetDir: dir,
      touchedTestPaths: ["test_touched.py"],
      newTestPaths: ["test_touched.py"],
      repoMap,
      scopeReport,
      baseline: allPassingBaseline(["test_sound.py::test_a", "test_touched.py::test_touched"]),
    });

    expect(result.passed).toBe(false);
    expect(result.failedLevel).toBe("full-suite");
    expect(result.levels.find((l) => l.level === "full-suite")?.raw).toBe(
      "new failures vs baseline: test_sound.py",
    );
  });

  it("fails full-suite when a baseline-passing test is missing from the final scan (deleted test)", async () => {
    dir = mkdtempSync(join(tmpdir(), "verify-ladder-"));
    writeFileSync(join(dir, "test_kept.py"), "def test_kept():\n    assert True\n");
    writeFileSync(join(dir, "test_touched.py"), "def test_touched():\n    assert True\n");

    const repoMap: RepoMap = {
      files: ["test_kept.py", "test_touched.py"],
      testFiles: ["test_kept.py", "test_touched.py"],
      imports: {},
      symbols: {},
    };
    const scopeReport: ScopeReport = { inScope: ["test_touched.py"], reason: "test" };

    const stubRunner: TargetRunner = {
      ...runner,
      async runTestsVerbose(_workDir) {
        // test_kept.py::test_gone was passing at baseline but no longer exists — and
        // produces no failure, which is exactly why presence must be checked.
        return {
          exitCode: 0,
          tests: [
            { nodeId: "test_kept.py::test_kept", outcome: "passed" },
            { nodeId: "test_touched.py::test_touched", outcome: "passed" },
          ],
        };
      },
    };

    const result = await runVerifyLadder({
      runner: stubRunner,
      targetDir: dir,
      touchedTestPaths: ["test_touched.py"],
      newTestPaths: ["test_touched.py"],
      repoMap,
      scopeReport,
      baseline: allPassingBaseline([
        "test_kept.py::test_kept",
        "test_kept.py::test_gone",
        "test_touched.py::test_touched",
      ]),
    });

    expect(result.passed).toBe(false);
    expect(result.failedLevel).toBe("full-suite");
    expect(result.levels.find((l) => l.level === "full-suite")?.raw).toBe(
      "baseline tests missing from final suite: test_kept.py::test_gone",
    );
  });

  it("passes full-suite when extra new tests are present beyond baseline", async () => {
    dir = mkdtempSync(join(tmpdir(), "verify-ladder-"));
    writeFileSync(join(dir, "test_kept.py"), "def test_kept():\n    assert True\n");

    const repoMap: RepoMap = {
      files: ["test_kept.py"],
      testFiles: ["test_kept.py"],
      imports: {},
      symbols: {},
    };
    const scopeReport: ScopeReport = { inScope: ["test_kept.py"], reason: "test" };

    const stubRunner: TargetRunner = {
      ...runner,
      async runTestsVerbose(_workDir) {
        return {
          exitCode: 0,
          tests: [
            { nodeId: "test_kept.py::test_kept", outcome: "passed" },
            { nodeId: "test_kept.py::test_brand_new", outcome: "passed" },
          ],
        };
      },
    };

    const result = await runVerifyLadder({
      runner: stubRunner,
      targetDir: dir,
      touchedTestPaths: ["test_kept.py"],
      newTestPaths: ["test_kept.py"],
      repoMap,
      scopeReport,
      baseline: allPassingBaseline(["test_kept.py::test_kept"]),
    });

    expect(result.passed).toBe(true);
    expect(result.levels.find((l) => l.level === "full-suite")?.passed).toBe(true);
  });

  it("fails full-suite when the verbose run produces no parseable results", async () => {
    dir = mkdtempSync(join(tmpdir(), "verify-ladder-"));
    writeFileSync(join(dir, "test_a.py"), "def test_a():\n    assert True\n");

    const repoMap: RepoMap = { files: ["test_a.py"], testFiles: ["test_a.py"], imports: {}, symbols: {} };
    const scopeReport: ScopeReport = { inScope: ["test_a.py"], reason: "test" };

    const stubRunner: TargetRunner = {
      ...runner,
      async runTestsVerbose(_workDir) {
        return { exitCode: 2, tests: [] };
      },
    };

    const result = await runVerifyLadder({
      runner: stubRunner,
      targetDir: dir,
      touchedTestPaths: ["test_a.py"],
      newTestPaths: ["test_a.py"],
      repoMap,
      scopeReport,
      baseline: allPassingBaseline(["test_a.py::test_a"]),
    });

    expect(result.passed).toBe(false);
    expect(result.failedLevel).toBe("full-suite");
    expect(result.levels.find((l) => l.level === "full-suite")?.raw).toBe(
      "full-suite run produced no parseable results (exit 2)",
    );
  });

  it("makes impacted-subgraph baseline-relative: tolerates an in-scope pre-existing failure and ignores an out-of-scope regression outside the level's own paths", async () => {
    const { runVerifyLadder: runVerifyLadderUnderTest } = await import("../../src/phases/verify.js");

    dir = mkdtempSync(join(tmpdir(), "verify-ladder-"));
    writeFileSync(
      join(dir, "test_scope_a.py"),
      "def test_ok():\n    assert True\n\n\ndef test_broken():\n    assert False\n",
    );
    writeFileSync(join(dir, "test_scope_b.py"), "def test_scope_b():\n    assert True\n");
    // Present on disk (so a whole-directory verbose scan would see it) but NOT tracked as a
    // test file in repoMap/scopeReport, so it falls outside the impacted-subgraph level's own paths.
    writeFileSync(join(dir, "test_outside.py"), "def test_outside():\n    assert False\n");

    const repoMap: RepoMap = {
      files: ["test_scope_a.py", "test_scope_b.py", "test_outside.py"],
      testFiles: ["test_scope_a.py", "test_scope_b.py"],
      imports: {},
      symbols: {},
    };
    const scopeReport: ScopeReport = { inScope: ["test_scope_a.py", "test_scope_b.py"], reason: "test" };

    const result = await runVerifyLadderUnderTest({
      runner,
      targetDir: dir,
      touchedTestPaths: ["test_scope_b.py"],
      newTestPaths: ["test_scope_b.py"],
      repoMap,
      scopeReport,
      baseline: {
        tests: [
          { nodeId: "test_scope_a.py::test_ok", outcome: "passed" },
          { nodeId: "test_scope_a.py::test_broken", outcome: "failed" },
          { nodeId: "test_scope_b.py::test_scope_b", outcome: "passed" },
          { nodeId: "test_outside.py::test_outside", outcome: "passed" },
        ],
      },
    });

    const impacted = result.levels.find((l) => l.level === "impacted-subgraph");
    // test_scope_a.py was already failing at baseline (not sound), so it is tolerated and the
    // level passes via the baseline-relative recheck restricted to its own paths.
    expect(impacted?.passed).toBe(true);
    expect(impacted?.raw).toContain("test_scope_a.py");
    // test_outside.py is a baseline-sound path that now regresses, but it is outside the
    // impacted-subgraph level's own paths, so it must not affect that level. The untouched,
    // whole-repo full-suite level is the one that catches it.
    expect(result.levels.map((l) => l.level)).toEqual(["focused", "spec", "impacted-subgraph", "full-suite"]);
    expect(result.failedLevel).toBe("full-suite");
    expect(result.passed).toBe(false);
  });
});
