import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runVerifyLadder } from "../../src/phases/verify.js";
import type { RepoMap } from "../../src/phases/map.js";
import type { ScopeReport } from "../../src/phases/scope.js";

const FIXTURE_VENV = join(process.cwd(), "fixtures", "add-kata", ".venv");

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
    };
    const scopeReport: ScopeReport = { inScope: ["test_a.py", "test_b.py"], reason: "test" };

    const result = await runVerifyLadder({
      venvDir: FIXTURE_VENV,
      targetDir: dir,
      touchedTestPaths: ["test_a.py"],
      newTestPaths: ["test_a.py"],
      repoMap,
      scopeReport,
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
    };
    const scopeReport: ScopeReport = { inScope: ["test_a.py", "test_b.py"], reason: "test" };

    const result = await runVerifyLadder({
      venvDir: FIXTURE_VENV,
      targetDir: dir,
      touchedTestPaths: ["test_a.py"],
      newTestPaths: ["test_a.py"],
      repoMap,
      scopeReport,
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

    const repoMap: RepoMap = { files: ["test_a.py"], testFiles: ["test_a.py"], imports: {} };
    const scopeReport: ScopeReport = { inScope: ["test_a.py"], reason: "test" };

    const result = await runVerifyLadder({
      venvDir: FIXTURE_VENV,
      targetDir: dir,
      touchedTestPaths: ["test_a.py"],
      newTestPaths: ["test_a.py"],
      repoMap,
      scopeReport,
    });

    expect(result.passed).toBe(true);
    expect(result.levels.every((l) => l.passed)).toBe(true);
  });

  it("falls back to touchedTestPaths for impacted-subgraph when no in-scope test files are tracked", async () => {
    dir = mkdtempSync(join(tmpdir(), "verify-ladder-"));
    writeFileSync(join(dir, "test_a.py"), "def test_a():\n    assert True\n");

    const repoMap: RepoMap = { files: ["test_a.py"], testFiles: [], imports: {} };
    const scopeReport: ScopeReport = { inScope: [], reason: "test" };

    const result = await runVerifyLadder({
      venvDir: FIXTURE_VENV,
      targetDir: dir,
      touchedTestPaths: ["test_a.py"],
      newTestPaths: ["test_a.py"],
      repoMap,
      scopeReport,
    });

    expect(result.passed).toBe(true);
  });
});
