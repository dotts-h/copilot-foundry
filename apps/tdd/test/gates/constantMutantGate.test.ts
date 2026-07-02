import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCommand } from "../../src/exec.js";
import { checkConstantMutant } from "../../src/gates/constantMutantGate.js";
import { createPythonRunner } from "../../src/runner/pythonRunner.js";

const FIXTURE = join(process.cwd(), "fixtures", "add-kata");
const VENV = join(FIXTURE, ".venv");
const runner = createPythonRunner(VENV);

function setupWorkDir(testVariant: string): string {
  const dir = mkdtempSync(join(tmpdir(), "mutant-gate-"));
  cpSync(join(FIXTURE, "variants", "correct.py"), join(dir, "add_kata.py"));
  cpSync(join(FIXTURE, "variants", testVariant), join(dir, "test_add_kata.py"));
  return dir;
}

describe("constant-mutant gate", () => {
  let dir: string;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("the constant mutant SURVIVES a weak, one-example test suite (gate must reject)", async () => {
    dir = setupWorkDir("weak_test_add_kata.py");
    const result = await checkConstantMutant({
      workDir: dir,
      runner,
      implRelPath: "add_kata.py",
      mutantSourcePath: join(FIXTURE, "variants", "constant_mutant.py"),
      testRelPath: "test_add_kata.py",
    });
    expect(result.mutantSurvived).toBe(true);
  });

  it("the constant mutant is KILLED by a second, differently-valued test (gate passes)", async () => {
    dir = setupWorkDir("strong_test_add_kata.py");
    const result = await checkConstantMutant({
      workDir: dir,
      runner,
      implRelPath: "add_kata.py",
      mutantSourcePath: join(FIXTURE, "variants", "constant_mutant.py"),
      testRelPath: "test_add_kata.py",
    });
    expect(result.mutantSurvived).toBe(false);
  });

  it("restores the original (correct) implementation file after checking, regardless of outcome", async () => {
    dir = setupWorkDir("weak_test_add_kata.py");
    await checkConstantMutant({
      workDir: dir,
      runner,
      implRelPath: "add_kata.py",
      mutantSourcePath: join(FIXTURE, "variants", "constant_mutant.py"),
      testRelPath: "test_add_kata.py",
    });
    const { stdout } = await runCommand("cat", [join(dir, "add_kata.py")]);
    expect(stdout).toContain("return a + b");
    expect(stdout).not.toContain("return 5");
  });
});
