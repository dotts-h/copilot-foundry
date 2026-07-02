import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyJsMutation, computeJsMutationScore } from "../../src/runner/jsMutation.js";

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

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("reports applied:false when the operator does not apply", async () => {
    dir = mkdtempSync(join(tmpdir(), "js-mutation-"));
    const source = "export function add(a: number, b: number) {\n  return a + b;\n}\n";
    writeFileSync(join(dir, "math.ts"), source);
    const runTestsFocused = vi.fn().mockResolvedValue({ exitCode: 1, raw: "failed" });

    const score = await computeJsMutationScore(runTestsFocused, {
      workDir: dir,
      implRelPath: "math.ts",
      functionName: "add",
      testRelPath: "math.test.ts",
    });

    const comparison = score.results.find((r) => r.operator === "comparison-swap");
    expect(comparison).toEqual({ operator: "comparison-swap", applied: false, survived: null });
  });

  it("restores the original file even when runTestsFocused throws", async () => {
    dir = mkdtempSync(join(tmpdir(), "js-mutation-"));
    const source = "export function add(a: number, b: number) {\n  return a + b;\n}\n";
    writeFileSync(join(dir, "math.ts"), source);
    const runTestsFocused = vi.fn().mockRejectedValue(new Error("boom"));

    await expect(
      computeJsMutationScore(runTestsFocused, {
        workDir: dir,
        implRelPath: "math.ts",
        functionName: "add",
        testRelPath: "math.test.ts",
      }),
    ).rejects.toThrow("boom");

    expect(readFileSync(join(dir, "math.ts"), "utf8")).toBe(source);
  });

  it("treats harness_error focused runs as applied:false", async () => {
    dir = mkdtempSync(join(tmpdir(), "js-mutation-"));
    writeFileSync(join(dir, "math.ts"), "export function add(a: number, b: number) {\n  return a + b;\n}\n");
    const runTestsFocused = vi.fn().mockResolvedValue({
      exitCode: 1,
      raw: "Failed to load config",
    });

    const score = await computeJsMutationScore(runTestsFocused, {
      workDir: dir,
      implRelPath: "math.ts",
      functionName: "add",
      testRelPath: "math.test.ts",
    });

    const arithmetic = score.results.find((r) => r.operator === "arithmetic-swap");
    expect(arithmetic).toEqual({ operator: "arithmetic-swap", applied: false, survived: null });
  });

  it("computes score from killed mutants", async () => {
    dir = mkdtempSync(join(tmpdir(), "js-mutation-"));
    writeFileSync(join(dir, "math.ts"), "export function add(a: number, b: number) {\n  return a + b;\n}\n");
    const runTestsFocused = vi.fn().mockResolvedValue({ exitCode: 1, raw: "failed" });

    const score = await computeJsMutationScore(runTestsFocused, {
      workDir: dir,
      implRelPath: "math.ts",
      functionName: "add",
      testRelPath: "math.test.ts",
    });

    const arithmetic = score.results.find((r) => r.operator === "arithmetic-swap");
    expect(arithmetic?.applied).toBe(true);
    expect(arithmetic?.survived).toBe(false);
    expect(score.attemptedCount).toBeGreaterThan(0);
    expect(score.score).toBeGreaterThan(0);
  });
});
