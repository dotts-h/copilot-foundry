import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { JavaScriptAdapter, PythonAdapter } from "../../src/languages/adapter.js";

const FIXTURE_VENV = join(process.cwd(), "fixtures", "add-kata", ".venv");

describe("PythonAdapter", () => {
  let dir: string;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("runs pytest and reports pass/fail via exit code", async () => {
    dir = mkdtempSync(join(tmpdir(), "python-adapter-"));
    writeFileSync(join(dir, "test_ok.py"), "def test_ok():\n    assert True\n");
    const adapter = new PythonAdapter(FIXTURE_VENV);
    const result = await adapter.runTests(dir);
    expect(result.exitCode).toBe(0);
  });

  it("reports verbose per-test outcomes", async () => {
    dir = mkdtempSync(join(tmpdir(), "python-adapter-"));
    writeFileSync(
      join(dir, "test_mixed.py"),
      "def test_pass():\n    assert True\n\n\ndef test_fail():\n    assert False\n",
    );
    const adapter = new PythonAdapter(FIXTURE_VENV);
    const result = await adapter.runTestsVerbose(dir);
    const byName = Object.fromEntries(result.tests.map((t) => [t.nodeId.split("::").pop(), t.outcome]));
    expect(byName.test_pass).toBe("passed");
    expect(byName.test_fail).toBe("failed");
  });
});

describe("JavaScriptAdapter", () => {
  let dir: string;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("runs node --test and reports pass/fail via exit code", async () => {
    dir = mkdtempSync(join(tmpdir(), "js-adapter-"));
    mkdirSync(join(dir, "test"));
    writeFileSync(
      join(dir, "test", "ok.test.js"),
      "const { test } = require('node:test');\nconst assert = require('node:assert');\n\n" +
        "test('ok', () => { assert.strictEqual(1 + 1, 2); });\n",
    );
    const adapter = new JavaScriptAdapter();
    const result = await adapter.runTests(dir);
    expect(result.exitCode).toBe(0);
  });

  it("reports verbose per-test outcomes via TAP output", async () => {
    dir = mkdtempSync(join(tmpdir(), "js-adapter-"));
    mkdirSync(join(dir, "test"));
    writeFileSync(
      join(dir, "test", "mixed.test.js"),
      "const { test } = require('node:test');\nconst assert = require('node:assert');\n\n" +
        "test('pass', () => { assert.ok(true); });\ntest('fail', () => { assert.ok(false); });\n",
    );
    const adapter = new JavaScriptAdapter();
    const result = await adapter.runTestsVerbose(dir);
    const byName = Object.fromEntries(result.tests.map((t) => [t.nodeId, t.outcome]));
    expect(byName.pass).toBe("passed");
    expect(byName.fail).toBe("failed");
  });
});
