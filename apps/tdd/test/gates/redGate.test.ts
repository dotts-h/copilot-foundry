import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { classifyRedOutcome, isMissingSymbolCollectionError } from "../../src/gates/redGate.js";
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
      functionName: "irrelevant",
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
      functionName: "irrelevant",
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
      functionName: "irrelevant",
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
      functionName: "irrelevant",
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
      functionName: "irrelevant",
      baseline,
    });

    expect(result.outcome).toBe("failed_as_expected");
    expect(result.preexistingRegressionPaths).toContain("test_other.py");
  });

  it("classifies a module-top import of a not-yet-existing symbol as failed_as_expected -- the canonical first RED for a new function", async () => {
    dir = mkdtempSync(join(tmpdir(), "red-gate-"));
    const baseline = await runBaseline(FIXTURE_VENV, dir);
    writeFileSync(join(dir, "calc.py"), "def other_fn():\n    return 1\n");
    writeFileSync(
      join(dir, "test_new.py"),
      "from calc import expected_session_fraction\n\n\n" +
        "def test_returns_correct_fraction():\n" +
        "    assert expected_session_fraction(10, 100) == 0.1\n" +
        "    assert expected_session_fraction(50, 100) == 0.5\n",
    );

    const result = await classifyRedOutcome({
      targetDir: dir,
      venvDir: FIXTURE_VENV,
      testRelPath: "test_new.py",
      functionName: "expected_session_fraction",
      baseline,
    });

    expect(result.outcome).toBe("failed_as_expected");
    expect(result.passed).toBe(true);
  });

  it("still classifies a genuine collection error (syntax error) as collection_error and fails the gate", async () => {
    dir = mkdtempSync(join(tmpdir(), "red-gate-"));
    const baseline = await runBaseline(FIXTURE_VENV, dir);
    writeFileSync(join(dir, "calc.py"), "def other_fn():\n    return 1\n");
    writeFileSync(join(dir, "test_new.py"), "def test_broken(:\n    assert True\n");

    const result = await classifyRedOutcome({
      targetDir: dir,
      venvDir: FIXTURE_VENV,
      testRelPath: "test_new.py",
      functionName: "expected_session_fraction",
      baseline,
    });

    expect(result.outcome).toBe("collection_error");
    expect(result.passed).toBe(false);
  });
});

describe("isMissingSymbolCollectionError", () => {
  it("matches the three canonical missing-symbol pytest signatures for the given function name, regex-escaped", () => {
    expect(isMissingSymbolCollectionError("ImportError: cannot import name 'foo' from 'calc'", "foo")).toBe(true);
    expect(isMissingSymbolCollectionError("AttributeError: module 'calc' has no attribute 'foo'", "foo")).toBe(
      true,
    );
    expect(isMissingSymbolCollectionError("NameError: name 'foo' is not defined", "foo")).toBe(true);
    expect(isMissingSymbolCollectionError("SyntaxError: invalid syntax", "foo")).toBe(false);
    expect(isMissingSymbolCollectionError("cannot import name 'foo_bar' from 'calc'", "foo")).toBe(false);
  });
});
