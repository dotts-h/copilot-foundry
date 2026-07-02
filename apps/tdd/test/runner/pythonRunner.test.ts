import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPythonRunner, PYTHON_RED_PROMPT_RULES } from "../../src/runner/pythonRunner.js";

const FIXTURE_VENV = join(process.cwd(), "fixtures", "add-kata", ".venv");

describe("createPythonRunner", () => {
  let dir: string;
  let runner: ReturnType<typeof createPythonRunner>;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  beforeEach(() => {
    runner = createPythonRunner(FIXTURE_VENV);
  });

  it("classifyRun maps exit codes 0/1/other to passed/failed/harness_error", () => {
    expect(runner.classifyRun({ exitCode: 0, raw: "" })).toBe("passed");
    expect(runner.classifyRun({ exitCode: 1, raw: "" })).toBe("failed");
    expect(runner.classifyRun({ exitCode: 2, raw: "" })).toBe("harness_error");
    expect(runner.classifyRun({ exitCode: 5, raw: "" })).toBe("harness_error");
  });

  it("testPathKey is identity for python", () => {
    expect(runner.testPathKey("test_foo.py")).toBe("test_foo.py");
    expect(runner.testPathKey("pkg/test_foo.py")).toBe("pkg/test_foo.py");
  });

  it("redPromptRules equals the previously hardcoded import-inside-test-function text", () => {
    expect(runner.redPromptRules).toBe(PYTHON_RED_PROMPT_RULES);
    expect(runner.redPromptRules).toContain("import it inside the new test function(s) instead");
    expect(runner.redPromptRules).toContain("Never modify or remove existing imports.");
  });

  it("returns exit code 0 when all tests pass", async () => {
    dir = mkdtempSync(join(tmpdir(), "pytest-runner-"));
    writeFileSync(join(dir, "test_ok.py"), "def test_ok():\n    assert 1 + 1 == 2\n");
    const result = await runner.runTests(dir);
    expect(result.exitCode).toBe(0);
  });

  it("returns exit code 1 when a test fails", async () => {
    dir = mkdtempSync(join(tmpdir(), "pytest-runner-"));
    writeFileSync(join(dir, "test_fail.py"), "def test_fail():\n    assert 1 + 1 == 3\n");
    const result = await runner.runTests(dir);
    expect(result.exitCode).toBe(1);
    expect(result.raw).toMatch(/1 failed/);
  });

  it("scopes the run to targetRelPath when given", async () => {
    dir = mkdtempSync(join(tmpdir(), "pytest-runner-"));
    writeFileSync(join(dir, "test_a.py"), "def test_a():\n    assert True\n");
    writeFileSync(join(dir, "test_b.py"), "def test_b():\n    assert False\n");
    const result = await runner.runTests(dir, "test_a.py");
    expect(result.exitCode).toBe(0);
  });

  it("does not reuse stale cached bytecode when the target module is rewritten between runs", async () => {
    dir = mkdtempSync(join(tmpdir(), "pytest-runner-"));
    writeFileSync(join(dir, "m.py"), "def value():\n    return 1\n");
    writeFileSync(join(dir, "test_m.py"), "from m import value\n\ndef test_value():\n    assert value() == 2\n");

    const first = await runner.runTests(dir, "test_m.py");
    expect(first.exitCode).toBe(1);

    writeFileSync(join(dir, "m.py"), "def value():\n    return 2\n");
    const second = await runner.runTests(dir, "test_m.py");
    expect(second.exitCode).toBe(0);
  });

  it("neutralizes a target repo's ini addopts so its coverage floor cannot fail the gate", async () => {
    dir = mkdtempSync(join(tmpdir(), "pytest-runner-"));
    writeFileSync(
      join(dir, "pytest.ini"),
      "[pytest]\naddopts = --cov=foo --cov-report=term-missing --cov-fail-under=70\n",
    );
    writeFileSync(join(dir, "test_ok.py"), "def test_ok():\n    assert 1 + 1 == 2\n");
    const result = await runner.runTests(dir);
    expect(result.exitCode).toBe(0);
  });

  describe("lintRedTest", () => {
    it("blocks an empty test file", () => {
      const result = runner.lintRedTest("");
      expect(result.blocking).toContain("test file is empty");
    });

    it("blocks a test file with no assert statements", () => {
      const result = runner.lintRedTest("def test_nothing():\n    pass\n");
      expect(result.blocking).toContain("no assert statements found");
    });

    it("warns (does not block) on a single assertion, citing triangulation", () => {
      const result = runner.lintRedTest("def test_add():\n    assert add(2, 3) == 5\n");
      expect(result.blocking).toEqual([]);
      expect(result.warnings.some((w) => /triangulat/.test(w))).toBe(true);
    });

    it("does not warn about triangulation when there are two or more assertions", () => {
      const result = runner.lintRedTest(
        "def test_add():\n    assert add(2, 3) == 5\n    assert add(0, 0) == 0\n",
      );
      expect(result.warnings.some((w) => /triangulat/.test(w))).toBe(false);
    });

    it("warns on == True / == False literal comparisons", () => {
      const result = runner.lintRedTest(
        "def test_flag():\n    assert is_ok() == True\n    assert is_bad() == False\n",
      );
      expect(result.warnings.some((w) => /True.*False/.test(w))).toBe(true);
    });

    it("flags a suite where every test asserts the same literal value (weak triangulation across the file)", () => {
      const result = runner.lintRedTest(
        "def test_a():\n    assert add(2, 3) == 5\n\n\ndef test_b():\n    assert add(1, 4) == 5\n",
      );
      expect(result.warnings.some((w) => /same expected value/.test(w))).toBe(true);
    });

    it("does not flag suite-level weak-triangulation when assertions target different values", () => {
      const result = runner.lintRedTest(
        "def test_a():\n    assert add(2, 3) == 5\n\n\ndef test_b():\n    assert add(1, 1) == 2\n",
      );
      expect(result.warnings.some((w) => /same expected value/.test(w))).toBe(false);
    });
  });
});
