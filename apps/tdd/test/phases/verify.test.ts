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
});
