import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkConstantMutantGeneric } from "../../src/gates/mutationGate.js";

const FIXTURE_VENV = join(process.cwd(), "fixtures", "add-kata", ".venv");

describe("checkConstantMutantGeneric", () => {
  let dir: string;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("the mutant survives a weak, single-example test", async () => {
    dir = mkdtempSync(join(tmpdir(), "mutation-gate-"));
    writeFileSync(join(dir, "add_kata.py"), "def add(a, b):\n    return a + b\n");
    writeFileSync(
      join(dir, "test_add_kata.py"),
      "from add_kata import add\n\ndef test_add():\n    assert add(2, 3) == 5\n",
    );

    const result = await checkConstantMutantGeneric({
      workDir: dir,
      venvDir: FIXTURE_VENV,
      implRelPath: "add_kata.py",
      functionName: "add",
      testRelPath: "test_add_kata.py",
    });

    expect(result.attempted).toBe(true);
    expect(result.mutantSurvived).toBe(true);
    expect(result.constantUsed).toBe(5);
  });

  it("the mutant is killed by a second, differently-valued assertion", async () => {
    dir = mkdtempSync(join(tmpdir(), "mutation-gate-"));
    writeFileSync(join(dir, "add_kata.py"), "def add(a, b):\n    return a + b\n");
    writeFileSync(
      join(dir, "test_add_kata.py"),
      "from add_kata import add\n\ndef test_add():\n    assert add(2, 3) == 5\n    assert add(0, 0) == 0\n",
    );

    const result = await checkConstantMutantGeneric({
      workDir: dir,
      venvDir: FIXTURE_VENV,
      implRelPath: "add_kata.py",
      functionName: "add",
      testRelPath: "test_add_kata.py",
    });

    expect(result.attempted).toBe(true);
    expect(result.mutantSurvived).toBe(false);
  });

  it("restores the original implementation after checking, regardless of outcome", async () => {
    dir = mkdtempSync(join(tmpdir(), "mutation-gate-"));
    const original = "def add(a, b):\n    return a + b\n";
    writeFileSync(join(dir, "add_kata.py"), original);
    writeFileSync(
      join(dir, "test_add_kata.py"),
      "from add_kata import add\n\ndef test_add():\n    assert add(2, 3) == 5\n",
    );

    await checkConstantMutantGeneric({
      workDir: dir,
      venvDir: FIXTURE_VENV,
      implRelPath: "add_kata.py",
      functionName: "add",
      testRelPath: "test_add_kata.py",
    });

    expect(readFileSync(join(dir, "add_kata.py"), "utf8")).toBe(original);
  });

  it("reports attempted:false when no literal-argument call to the function is found", async () => {
    dir = mkdtempSync(join(tmpdir(), "mutation-gate-"));
    writeFileSync(join(dir, "add_kata.py"), "def add(a, b):\n    return a + b\n");
    writeFileSync(
      join(dir, "test_add_kata.py"),
      "from add_kata import add\n\ndef test_add():\n    x, y = 2, 3\n    assert add(x, y) == 5\n",
    );

    const result = await checkConstantMutantGeneric({
      workDir: dir,
      venvDir: FIXTURE_VENV,
      implRelPath: "add_kata.py",
      functionName: "add",
      testRelPath: "test_add_kata.py",
    });

    expect(result.attempted).toBe(false);
    expect(result.mutantSurvived).toBeNull();
  });

  it("does not throw when the target module prints to stdout on import", async () => {
    dir = mkdtempSync(join(tmpdir(), "mutation-gate-"));
    writeFileSync(
      join(dir, "add_kata.py"),
      'print("some debug output")\ndef add(a, b):\n    return a + b\n',
    );
    writeFileSync(
      join(dir, "test_add_kata.py"),
      "from add_kata import add\n\ndef test_add():\n    assert add(2, 3) == 5\n",
    );

    const result = await checkConstantMutantGeneric({
      workDir: dir,
      venvDir: FIXTURE_VENV,
      implRelPath: "add_kata.py",
      functionName: "add",
      testRelPath: "test_add_kata.py",
    });

    expect(result.attempted).toBe(true);
    expect(result.mutantSurvived).toBe(true);
    expect(result.constantUsed).toBe(5);
  });
});
