import { execSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { classifyGoRun } from "../../src/runner/goRunner.js";
import { computeGoMutationScore, runGoExtractExpected, runGoMutator } from "../../src/runner/goMutation.js";

const KATA_GO = join(process.cwd(), "kata-go");

function hasGo(): boolean {
  try {
    execSync("go version", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const goAvailable = hasGo();

describe.skipIf(!goAvailable)("runGoExtractExpected", () => {
  let dir: string;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it.each([
    {
      name: "if got := Multiply(2, 3); got != 6",
      testSource:
        "package math\n\nimport \"testing\"\n\n" +
        "func TestMultiply(t *testing.T) {\n" +
        "\tif got := Multiply(2, 3); got != 6 {\n" +
        "\t\tt.Fatalf(\"got %d want 6\", got)\n" +
        "\t}\n" +
        "}\n",
      expected: "6",
    },
    {
      name: "got := Multiply(2,3) then if got != 6",
      testSource:
        "package math\n\nimport \"testing\"\n\n" +
        "func TestMultiply(t *testing.T) {\n" +
        "\tgot := Multiply(2, 3)\n" +
        "\tif got != 6 {\n" +
        "\t\tt.Fatalf(\"got %d want 6\", got)\n" +
        "\t}\n" +
        "}\n",
      expected: "6",
    },
  ])("extracts the want literal from $name", async ({ testSource, expected }) => {
    dir = mkdtempSync(join(tmpdir(), "go-extract-"));
    const testPath = join(dir, "math_test.go");
    writeFileSync(testPath, testSource);

    const result = await runGoExtractExpected(testPath, "Multiply");
    expect(result).toEqual({ found: true, literal: expected });
  });
});

describe.skipIf(!goAvailable)("computeGoMutationScore constant operator", () => {
  let dir: string;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("runs the constant operator first in results", async () => {
    dir = mkdtempSync(join(tmpdir(), "go-mutation-"));
    writeFileSync(join(dir, "go.mod"), "module example.com/math\n\ngo 1.22\n");
    writeFileSync(join(dir, "math.go"), "package math\n\nfunc Add(a, b int) int {\n\treturn a + b\n}\n");
    writeFileSync(
      join(dir, "math_test.go"),
      "package math\n\nimport \"testing\"\n\nfunc TestAdd(t *testing.T) {\n\tif Add(2, 3) != 5 {\n\t\tt.Fatal(\"bad\")\n\t}\n}\n",
    );
    const runTestsFocused = vi.fn().mockResolvedValue({ exitCode: 1, raw: "FAIL" });

    const score = await computeGoMutationScore(
      runTestsFocused,
      {
        workDir: dir,
        implRelPath: "math.go",
        functionName: "Add",
        testRelPath: "math_test.go",
      },
      classifyGoRun,
      join(dir, "math_test.go"),
    );

    expect(score.results[0]?.operator).toBe("constant");
  });

  it("treats a non-compiling constant mutant on a multi-return function as not_applicable", async () => {
    dir = mkdtempSync(join(tmpdir(), "go-mutation-"));
    writeFileSync(join(dir, "go.mod"), "module example.com/math\n\ngo 1.22\n");
    writeFileSync(
      join(dir, "math.go"),
      "package math\n\nfunc Pair() (int, string) {\n\treturn 1, \"x\"\n}\n",
    );
    writeFileSync(
      join(dir, "math_test.go"),
      "package math\n\nimport \"testing\"\n\nfunc TestPair(t *testing.T) {\n" +
        "\tif got, _ := Pair(); got != 1 {\n\t\tt.Fatalf(\"got %d want 1\", got)\n\t}\n}\n",
    );
    const runTestsFocused = vi.fn().mockResolvedValue({
      exitCode: 1,
      raw: "# example.com/math\n./math.go:3:9: not enough return values",
    });

    const score = await computeGoMutationScore(
      runTestsFocused,
      {
        workDir: dir,
        implRelPath: "math.go",
        functionName: "Pair",
        testRelPath: "math_test.go",
      },
      classifyGoRun,
      join(dir, "math_test.go"),
    );

    const constant = score.results.find((r) => r.operator === "constant");
    expect(constant).toEqual({ operator: "constant", outcome: "not_applicable", survived: null });
    expect(runTestsFocused).toHaveBeenCalledTimes(1);
  });

  it("constant mutant SURVIVES a hardcoded-return impl on the kata-go layout", async () => {
    dir = mkdtempSync(join(tmpdir(), "go-mutation-kata-"));
    writeFileSync(join(dir, "go.mod"), readFileSync(join(KATA_GO, "go.mod"), "utf8"));
    const implSource = "package kata\n\nfunc Add(a, b int) int {\n\treturn 5\n}\n";
    writeFileSync(join(dir, "calc.go"), implSource);
    const testSource = readFileSync(join(KATA_GO, "calc_test.go"), "utf8").split("\n").slice(0, 9).join("\n");
    writeFileSync(join(dir, "calc_test.go"), testSource);
    const runTestsFocused = vi.fn().mockResolvedValue({ exitCode: 0, raw: "ok" });

    const score = await computeGoMutationScore(
      runTestsFocused,
      {
        workDir: dir,
        implRelPath: "calc.go",
        functionName: "Add",
        testRelPath: "calc_test.go",
      },
      classifyGoRun,
      join(dir, "calc_test.go"),
    );

    const constant = score.results.find((r) => r.operator === "constant");
    expect(constant?.outcome).toBe("applied");
    expect(constant?.survived).toBe(true);
    expect(readFileSync(join(dir, "calc.go"), "utf8")).toBe(implSource);
  });

  it("constant mutant is KILLED by a two-value kata-go test against the real impl", async () => {
    dir = mkdtempSync(join(tmpdir(), "go-mutation-kata-"));
    writeFileSync(join(dir, "go.mod"), readFileSync(join(KATA_GO, "go.mod"), "utf8"));
    const implSource = readFileSync(join(KATA_GO, "calc.go"), "utf8");
    writeFileSync(join(dir, "calc.go"), implSource);
    const testSource = readFileSync(join(KATA_GO, "calc_test.go"), "utf8");
    writeFileSync(join(dir, "calc_test.go"), testSource);
    const runTestsFocused = vi.fn().mockResolvedValue({ exitCode: 1, raw: "FAIL" });

    const score = await computeGoMutationScore(
      runTestsFocused,
      {
        workDir: dir,
        implRelPath: "calc.go",
        functionName: "Add",
        testRelPath: "calc_test.go",
      },
      classifyGoRun,
      join(dir, "calc_test.go"),
    );

    const constant = score.results.find((r) => r.operator === "constant");
    expect(constant?.outcome).toBe("applied");
    expect(constant?.survived).toBe(false);
    expect(readFileSync(join(dir, "calc.go"), "utf8")).toBe(implSource);
  });
});

describe.skipIf(!goAvailable)("runGoMutator constant-return", () => {
  let dir: string;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("replaces a function body with a constant return", async () => {
    dir = mkdtempSync(join(tmpdir(), "go-mutator-constant-"));
    mkdirSync(join(dir, "pkg"), { recursive: true });
    writeFileSync(join(dir, "go.mod"), "module example.com/mut\n\ngo 1.22\n");
    writeFileSync(
      join(dir, "pkg", "math.go"),
      "package pkg\n\nfunc Multiply(a, b int) int {\n\treturn a * b\n}\n",
    );

    const result = await runGoMutator(join(dir, "pkg", "math.go"), "Multiply", "constant-return", "6");
    expect(result.applicable).toBe(true);
    expect(result.mutatedSource).toMatch(/return 6/);
    expect(result.mutatedSource).not.toMatch(/\*/);
  });
});
