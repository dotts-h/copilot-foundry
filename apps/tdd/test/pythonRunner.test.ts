import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runPytest } from "../src/pythonRunner.js";

const FIXTURE_VENV = join(process.cwd(), "fixtures", "add-kata", ".venv");

describe("runPytest", () => {
  let dir: string;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("returns exit code 0 when all tests pass", async () => {
    dir = mkdtempSync(join(tmpdir(), "pytest-runner-"));
    writeFileSync(join(dir, "test_ok.py"), "def test_ok():\n    assert 1 + 1 == 2\n");
    const result = await runPytest(FIXTURE_VENV, dir);
    expect(result.exitCode).toBe(0);
  });

  it("returns exit code 1 when a test fails", async () => {
    dir = mkdtempSync(join(tmpdir(), "pytest-runner-"));
    writeFileSync(join(dir, "test_fail.py"), "def test_fail():\n    assert 1 + 1 == 3\n");
    const result = await runPytest(FIXTURE_VENV, dir);
    expect(result.exitCode).toBe(1);
    expect(result.raw).toMatch(/1 failed/);
  });

  it("scopes the run to targetRelPath when given", async () => {
    dir = mkdtempSync(join(tmpdir(), "pytest-runner-"));
    writeFileSync(join(dir, "test_a.py"), "def test_a():\n    assert True\n");
    writeFileSync(join(dir, "test_b.py"), "def test_b():\n    assert False\n");
    const result = await runPytest(FIXTURE_VENV, dir, "test_a.py");
    expect(result.exitCode).toBe(0);
  });

  it("does not reuse stale cached bytecode when the target module is rewritten between runs", async () => {
    dir = mkdtempSync(join(tmpdir(), "pytest-runner-"));
    writeFileSync(join(dir, "m.py"), "def value():\n    return 1\n");
    writeFileSync(join(dir, "test_m.py"), "from m import value\n\ndef test_value():\n    assert value() == 2\n");

    const first = await runPytest(FIXTURE_VENV, dir, "test_m.py");
    expect(first.exitCode).toBe(1);

    writeFileSync(join(dir, "m.py"), "def value():\n    return 2\n");
    const second = await runPytest(FIXTURE_VENV, dir, "test_m.py");
    expect(second.exitCode).toBe(0);
  });

  it("neutralizes a target repo's ini addopts so its coverage floor cannot fail the gate", async () => {
    dir = mkdtempSync(join(tmpdir(), "pytest-runner-"));
    writeFileSync(
      join(dir, "pytest.ini"),
      "[pytest]\naddopts = --cov=foo --cov-report=term-missing --cov-fail-under=70\n",
    );
    writeFileSync(join(dir, "test_ok.py"), "def test_ok():\n    assert 1 + 1 == 2\n");
    const result = await runPytest(FIXTURE_VENV, dir);
    expect(result.exitCode).toBe(0);
  });
});
