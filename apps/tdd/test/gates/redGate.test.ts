import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { classifyRedOutcome } from "../../src/gates/redGate.js";
import { runBaseline } from "../../src/phases/baseline.js";

const FIXTURE_VENV = join(process.cwd(), "fixtures", "add-kata", ".venv");

describe("classifyRedOutcome", () => {
  let dir: string;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("classifies a genuinely failing new test as failed_as_expected and passes the gate", async () => {
    dir = mkdtempSync(join(tmpdir(), "red-gate-"));
    const baseline = await runBaseline(FIXTURE_VENV, dir);
    writeFileSync(join(dir, "test_new.py"), "def test_new():\n    assert 1 + 1 == 3\n");

    const result = await classifyRedOutcome({
      targetDir: dir,
      venvDir: FIXTURE_VENV,
      testRelPath: "test_new.py",
      baseline,
    });

    expect(result.outcome).toBe("failed_as_expected");
    expect(result.passed).toBe(true);
    expect(result.lint.blocking).toEqual([]);
  });

  it("classifies an already-passing new test as already_green and fails the gate", async () => {
    dir = mkdtempSync(join(tmpdir(), "red-gate-"));
    const baseline = await runBaseline(FIXTURE_VENV, dir);
    writeFileSync(join(dir, "test_new.py"), "def test_new():\n    assert 1 + 1 == 2\n");

    const result = await classifyRedOutcome({
      targetDir: dir,
      venvDir: FIXTURE_VENV,
      testRelPath: "test_new.py",
      baseline,
    });

    expect(result.outcome).toBe("already_green");
    expect(result.passed).toBe(false);
  });

  it("fails the gate when the test file was never created", async () => {
    dir = mkdtempSync(join(tmpdir(), "red-gate-"));
    const baseline = await runBaseline(FIXTURE_VENV, dir);

    const result = await classifyRedOutcome({
      targetDir: dir,
      venvDir: FIXTURE_VENV,
      testRelPath: "test_missing.py",
      baseline,
    });

    expect(result.outcome).toBe("missing_test_file");
    expect(result.passed).toBe(false);
  });

  it("fails the gate when the new test has no assertions, even though pytest itself exits 0", async () => {
    dir = mkdtempSync(join(tmpdir(), "red-gate-"));
    const baseline = await runBaseline(FIXTURE_VENV, dir);
    writeFileSync(join(dir, "test_new.py"), "def test_new():\n    pass\n");

    const result = await classifyRedOutcome({
      targetDir: dir,
      venvDir: FIXTURE_VENV,
      testRelPath: "test_new.py",
      baseline,
    });

    expect(result.lint.blocking).toContain("no assert statements found");
    expect(result.passed).toBe(false);
  });

  it("flags a preexisting-passing test that starts failing as a preexisting regression, without blocking the gate on it alone", async () => {
    dir = mkdtempSync(join(tmpdir(), "red-gate-"));
    writeFileSync(join(dir, "test_other.py"), "def test_other():\n    assert True\n");
    const baseline = await runBaseline(FIXTURE_VENV, dir);

    writeFileSync(join(dir, "test_other.py"), "def test_other():\n    assert False\n");
    writeFileSync(join(dir, "test_new.py"), "def test_new():\n    assert 1 + 1 == 3\n");

    const result = await classifyRedOutcome({
      targetDir: dir,
      venvDir: FIXTURE_VENV,
      testRelPath: "test_new.py",
      baseline,
    });

    expect(result.outcome).toBe("failed_as_expected");
    expect(result.preexistingRegressionPaths).toContain("test_other.py");
  });
});
