import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parsePytestVerboseOutput, runBaseline } from "../../src/phases/baseline.js";

const FIXTURE_VENV = join(process.cwd(), "fixtures", "add-kata", ".venv");

describe("runBaseline", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "baseline-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("reports passed and failed outcomes per test, keyed by path::name", async () => {
    writeFileSync(
      join(dir, "test_mixed.py"),
      "def test_pass():\n    assert True\n\n\ndef test_fail():\n    assert False\n",
    );

    const report = await runBaseline(FIXTURE_VENV, dir);

    const byName = Object.fromEntries(report.tests.map((t) => [t.nodeId.split("::").pop(), t.outcome]));
    expect(byName.test_pass).toBe("passed");
    expect(byName.test_fail).toBe("failed");
    expect(report.tests.every((t) => t.nodeId.startsWith("test_mixed.py::"))).toBe(true);
  });

  it("returns an empty report when there are no tests to collect", async () => {
    const report = await runBaseline(FIXTURE_VENV, dir);
    expect(report.tests).toEqual([]);
  });
});

describe("parsePytestVerboseOutput", () => {
  it("parses PASSED/FAILED/ERROR/SKIPPED lines into nodeId + outcome pairs", () => {
    const raw = [
      "test_a.py::test_one PASSED",
      "test_a.py::test_two FAILED",
      "test_b.py::test_three ERROR",
      "test_b.py::test_four SKIPPED",
      "some unrelated line we should ignore",
    ].join("\n");

    expect(parsePytestVerboseOutput(raw)).toEqual([
      { nodeId: "test_a.py::test_one", outcome: "passed" },
      { nodeId: "test_a.py::test_two", outcome: "failed" },
      { nodeId: "test_b.py::test_three", outcome: "error" },
      { nodeId: "test_b.py::test_four", outcome: "skipped" },
    ]);
  });
});
