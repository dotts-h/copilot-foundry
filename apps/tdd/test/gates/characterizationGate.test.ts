import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { classifyCharacterizationOutcome } from "../../src/gates/characterizationGate.js";

const FIXTURE_VENV = join(process.cwd(), "fixtures", "add-kata", ".venv");

describe("classifyCharacterizationOutcome", () => {
  let dir: string;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("classifies a test that accurately captures current (buggy) behavior as characterized", async () => {
    dir = mkdtempSync(join(tmpdir(), "characterization-gate-"));
    // A "legacy" off-by-one bug: divide(a, b) returns a // b + 1, not a // b.
    writeFileSync(join(dir, "legacy_kata.py"), "def divide(a, b):\n    return a // b + 1\n");
    writeFileSync(
      join(dir, "test_legacy_kata.py"),
      "from legacy_kata import divide\n\ndef test_divide_captures_current_off_by_one():\n    assert divide(10, 2) == 6\n",
    );

    const result = await classifyCharacterizationOutcome({
      targetDir: dir,
      venvDir: FIXTURE_VENV,
      testRelPath: "test_legacy_kata.py",
    });

    expect(result.outcome).toBe("characterized");
    expect(result.passed).toBe(true);
  });

  it("classifies a test that does not match current behavior as test_fails_immediately", async () => {
    dir = mkdtempSync(join(tmpdir(), "characterization-gate-"));
    writeFileSync(join(dir, "legacy_kata.py"), "def divide(a, b):\n    return a // b + 1\n");
    writeFileSync(
      join(dir, "test_legacy_kata.py"),
      "from legacy_kata import divide\n\ndef test_divide_wrong():\n    assert divide(10, 2) == 5\n",
    );

    const result = await classifyCharacterizationOutcome({
      targetDir: dir,
      venvDir: FIXTURE_VENV,
      testRelPath: "test_legacy_kata.py",
    });

    expect(result.outcome).toBe("test_fails_immediately");
    expect(result.passed).toBe(false);
  });

  it("classifies a missing test file as test_not_created", async () => {
    dir = mkdtempSync(join(tmpdir(), "characterization-gate-"));

    const result = await classifyCharacterizationOutcome({
      targetDir: dir,
      venvDir: FIXTURE_VENV,
      testRelPath: "test_legacy_kata.py",
    });

    expect(result.outcome).toBe("test_not_created");
    expect(result.passed).toBe(false);
  });
});
