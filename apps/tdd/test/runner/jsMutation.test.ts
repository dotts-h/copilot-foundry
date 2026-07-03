import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applyJsConstantMutation,
  applyJsMutation,
  computeJsMutationScore,
  extractJsExpectedLiteral,
} from "../../src/runner/jsMutation.js";

const KATA_TS = join(process.cwd(), "kata-ts");

describe("extractJsExpectedLiteral", () => {
  it.each([
    {
      name: "string literal from toBe",
      testSource: 'expect(formatBytes(1024)).toBe("1.0 KiB");',
      functionName: "formatBytes",
      expected: '"1.0 KiB"',
    },
    {
      name: "negative numeric from toBe",
      testSource: "expect(score()).toBe(-5);",
      functionName: "score",
      expected: "-5",
    },
  ])("$name", ({ testSource, functionName, expected }) => {
    expect(extractJsExpectedLiteral(testSource, "sample.test.ts", functionName)).toBe(expected);
  });

  it("returns null when the target is not a direct identifier call", () => {
    const testSource = "const x = add(2, 3);\nexpect(x).toBe(5);\n";
    expect(extractJsExpectedLiteral(testSource, "sample.test.ts", "add")).toBeNull();
  });
});

describe("applyJsConstantMutation", () => {
  it("replaces a function body with a constant return", () => {
    const source = "export function add(a: number, b: number) {\n  return a + b;\n}\n";
    const mutated = applyJsConstantMutation(source, "calc.ts", "add", "5");
    expect(mutated).toBe("export function add(a: number, b: number) { return 5; }\n");
  });

  it("replaces an arrow expression body with a constant return", () => {
    const source = "export const add = (a: number, b: number) => a + b;\n";
    const mutated = applyJsConstantMutation(source, "calc.ts", "add", "5");
    expect(mutated).toBe("export const add = (a: number, b: number) => 5;\n");
  });
});

describe("applyJsMutation", () => {
  it("swaps the first arithmetic operator inside the target function", () => {
    const source = "export function add(a: number, b: number) {\n  return a + b;\n}\n";
    const mutated = applyJsMutation(source, "math.ts", "add", "arithmetic-swap");
    expect(mutated).toBe("export function add(a: number, b: number) {\n  return a - b;\n}\n");
  });

  it("swaps the first comparison operator inside the target function", () => {
    const source = "export function isPos(x: number) {\n  return x > 0;\n}\n";
    const mutated = applyJsMutation(source, "math.ts", "isPos", "comparison-swap");
    expect(mutated).toBe("export function isPos(x: number) {\n  return x <= 0;\n}\n");
  });

  it("negates the first return expression", () => {
    const source = "export function ok(x: boolean) {\n  return x;\n}\n";
    const mutated = applyJsMutation(source, "logic.ts", "ok", "boolean-negation");
    expect(mutated).toBe("export function ok(x: boolean) {\n  return !(x);\n}\n");
  });

  it("returns null when no operator applies", () => {
    const source = "export function constant() {\n  return 1;\n}\n";
    expect(applyJsMutation(source, "math.ts", "constant", "comparison-swap")).toBeNull();
  });
});

describe("computeJsMutationScore", () => {
  let dir: string;

  const emptyTestSource = "";

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("runs the constant operator first in results", async () => {
    dir = mkdtempSync(join(tmpdir(), "js-mutation-"));
    writeFileSync(join(dir, "math.ts"), "export function add(a: number, b: number) {\n  return a + b;\n}\n");
    const runTestsFocused = vi.fn().mockResolvedValue({ exitCode: 1, raw: "failed" });

    const score = await computeJsMutationScore(
      runTestsFocused,
      {
        workDir: dir,
        implRelPath: "math.ts",
        functionName: "add",
        testRelPath: "math.test.ts",
      },
      "vitest",
      emptyTestSource,
    );

    expect(score.results[0]?.operator).toBe("constant");
  });

  it("reports constant outcome:not_applicable when no direct-call assertion exists", async () => {
    dir = mkdtempSync(join(tmpdir(), "js-mutation-"));
    writeFileSync(join(dir, "math.ts"), "export function add(a: number, b: number) {\n  return a + b;\n}\n");
    const runTestsFocused = vi.fn().mockResolvedValue({ exitCode: 1, raw: "failed" });
    const testSource = "const x = add(2, 3);\nexpect(x).toBe(5);\n";

    const score = await computeJsMutationScore(
      runTestsFocused,
      {
        workDir: dir,
        implRelPath: "math.ts",
        functionName: "add",
        testRelPath: "math.test.ts",
      },
      "vitest",
      testSource,
    );

    const constant = score.results.find((r) => r.operator === "constant");
    expect(constant).toEqual({ operator: "constant", outcome: "not_applicable", survived: null });
  });

  it("reports outcome:not_applicable when the operator does not apply", async () => {
    dir = mkdtempSync(join(tmpdir(), "js-mutation-"));
    const source = "export function add(a: number, b: number) {\n  return a + b;\n}\n";
    writeFileSync(join(dir, "math.ts"), source);
    const runTestsFocused = vi.fn().mockResolvedValue({ exitCode: 1, raw: "failed" });

    const score = await computeJsMutationScore(
      runTestsFocused,
      {
        workDir: dir,
        implRelPath: "math.ts",
        functionName: "add",
        testRelPath: "math.test.ts",
      },
      "vitest",
      emptyTestSource,
    );

    const comparison = score.results.find((r) => r.operator === "comparison-swap");
    expect(comparison).toEqual({ operator: "comparison-swap", outcome: "not_applicable", survived: null });
  });

  it("returns outcome:error when runTestsFocused throws, restoring the original file", async () => {
    dir = mkdtempSync(join(tmpdir(), "js-mutation-"));
    const source = "export function add(a: number, b: number) {\n  return a + b;\n}\n";
    writeFileSync(join(dir, "math.ts"), source);
    const runTestsFocused = vi.fn().mockRejectedValue(new Error("boom"));
    const testSource = "expect(add(2, 3)).toBe(5);\n";

    const score = await computeJsMutationScore(
      runTestsFocused,
      {
        workDir: dir,
        implRelPath: "math.ts",
        functionName: "add",
        testRelPath: "math.test.ts",
      },
      "vitest",
      testSource,
    );

    const constant = score.results.find((r) => r.operator === "constant");
    expect(constant?.outcome).toBe("error");
    expect(constant?.reason).toBe("boom");
    expect(readFileSync(join(dir, "math.ts"), "utf8")).toBe(source);
  });

  it("treats harness_error focused runs as outcome:not_applicable", async () => {
    dir = mkdtempSync(join(tmpdir(), "js-mutation-"));
    writeFileSync(join(dir, "math.ts"), "export function add(a: number, b: number) {\n  return a + b;\n}\n");
    const runTestsFocused = vi.fn().mockResolvedValue({
      exitCode: 1,
      raw: "Failed to load config",
    });
    const testSource = "expect(add(2, 3)).toBe(5);\n";

    const score = await computeJsMutationScore(
      runTestsFocused,
      {
        workDir: dir,
        implRelPath: "math.ts",
        functionName: "add",
        testRelPath: "math.test.ts",
      },
      "vitest",
      testSource,
    );

    const constant = score.results.find((r) => r.operator === "constant");
    expect(constant).toEqual({ operator: "constant", outcome: "not_applicable", survived: null });
  });

  it("computes score from killed mutants", async () => {
    dir = mkdtempSync(join(tmpdir(), "js-mutation-"));
    writeFileSync(join(dir, "math.ts"), "export function add(a: number, b: number) {\n  return a + b;\n}\n");
    const runTestsFocused = vi.fn().mockResolvedValue({ exitCode: 1, raw: "failed" });

    const score = await computeJsMutationScore(
      runTestsFocused,
      {
        workDir: dir,
        implRelPath: "math.ts",
        functionName: "add",
        testRelPath: "math.test.ts",
      },
      "vitest",
      emptyTestSource,
    );

    const arithmetic = score.results.find((r) => r.operator === "arithmetic-swap");
    expect(arithmetic?.outcome).toBe("applied");
    expect(arithmetic?.survived).toBe(false);
    expect(score.attemptedCount).toBeGreaterThan(0);
    expect(score.score).toBeGreaterThan(0);
  });

  it("constant mutant SURVIVES a hardcoded-return impl on the kata-ts layout", async () => {
    dir = mkdtempSync(join(tmpdir(), "js-mutation-kata-"));
    mkdirSync(join(dir, "src"), { recursive: true });
    mkdirSync(join(dir, "test"), { recursive: true });
    const implSource = "export function add(a: number, b: number) {\n  return 5;\n}\n";
    writeFileSync(join(dir, "src/calc.ts"), implSource);
    const testSource = readFileSync(join(KATA_TS, "test/calc.test.ts"), "utf8")
      .split("\n")
      .slice(0, 7)
      .concat(["});", ""])
      .join("\n");
    writeFileSync(join(dir, "test/calc.test.ts"), testSource);
    const runTestsFocused = vi.fn().mockResolvedValue({ exitCode: 0, raw: "passed" });

    const score = await computeJsMutationScore(
      runTestsFocused,
      {
        workDir: dir,
        implRelPath: "src/calc.ts",
        functionName: "add",
        testRelPath: "test/calc.test.ts",
      },
      "vitest",
      testSource,
    );

    const constant = score.results.find((r) => r.operator === "constant");
    expect(constant?.outcome).toBe("applied");
    expect(constant?.survived).toBe(true);
    expect(readFileSync(join(dir, "src/calc.ts"), "utf8")).toBe(implSource);
  });

  it("constant mutant is KILLED by a two-value kata-ts test against the real impl", async () => {
    dir = mkdtempSync(join(tmpdir(), "js-mutation-kata-"));
    mkdirSync(join(dir, "src"), { recursive: true });
    mkdirSync(join(dir, "test"), { recursive: true });
    const implSource = readFileSync(join(KATA_TS, "src/calc.ts"), "utf8");
    writeFileSync(join(dir, "src/calc.ts"), implSource);
    const testSource = readFileSync(join(KATA_TS, "test/calc.test.ts"), "utf8");
    writeFileSync(join(dir, "test/calc.test.ts"), testSource);
    const runTestsFocused = vi.fn().mockResolvedValue({ exitCode: 1, raw: "1 failed" });

    const score = await computeJsMutationScore(
      runTestsFocused,
      {
        workDir: dir,
        implRelPath: "src/calc.ts",
        functionName: "add",
        testRelPath: "test/calc.test.ts",
      },
      "vitest",
      testSource,
    );

    const constant = score.results.find((r) => r.operator === "constant");
    expect(constant?.outcome).toBe("applied");
    expect(constant?.survived).toBe(false);
    expect(readFileSync(join(dir, "src/calc.ts"), "utf8")).toBe(implSource);
  });
});
