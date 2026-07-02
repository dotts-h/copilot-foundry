import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { extractJsSymbols } from "../../src/runner/jsSymbols.js";

describe("extractJsSymbols", () => {
  let dir: string;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("extracts typed functions, async arrow consts, classes, and UPPER_SNAKE constants", async () => {
    dir = mkdtempSync(join(tmpdir(), "js-symbols-"));
    writeFileSync(
      join(dir, "sample.ts"),
      [
        "export const MAX_RETRIES = 3;",
        "export async function fetchUser(id: string): Promise<User> { return {} as User; }",
        "export const add = (a: number, b: number): number => a + b;",
        "export class Service {",
        "  run(): void {}",
        "  async go(): Promise<void> {}",
        "  #secret = 1;",
        "}",
      ].join("\n"),
    );

    const symbols = await extractJsSymbols(dir, ["sample.ts"]);
    expect(symbols["sample.ts"].functions).toEqual([
      { name: "fetchUser", signature: "async fetchUser(id: string): Promise<User>", line: 2 },
      { name: "add", signature: "add(a: number, b: number): number", line: 3 },
    ]);
    expect(symbols["sample.ts"].classes[0].name).toBe("Service");
    expect(symbols["sample.ts"].classes[0].methods.map((m) => m.name)).toEqual(["run", "go"]);
    expect(symbols["sample.ts"].constants).toEqual(["MAX_RETRIES"]);
  });

  it("extracts top-level const function expressions", async () => {
    dir = mkdtempSync(join(tmpdir(), "js-symbols-"));
    writeFileSync(
      join(dir, "helpers.ts"),
      "export const multiply = function (a: number, b: number): number {\n  return a * b;\n};\n",
    );

    const symbols = await extractJsSymbols(dir, ["helpers.ts"]);
    expect(symbols["helpers.ts"].functions).toEqual([
      { name: "multiply", signature: "multiply(a: number, b: number): number", line: 1 },
    ]);
  });

  it("returns error unparsed for broken source", async () => {
    dir = mkdtempSync(join(tmpdir(), "js-symbols-"));
    writeFileSync(join(dir, "broken.ts"), "function {{{");

    const symbols = await extractJsSymbols(dir, ["broken.ts"]);
    expect(symbols["broken.ts"]).toEqual({
      functions: [],
      classes: [],
      constants: [],
      error: "unparsed",
    });
  });

  it("skips non JS/TS extensions entirely", async () => {
    dir = mkdtempSync(join(tmpdir(), "js-symbols-"));
    writeFileSync(join(dir, "App.svelte"), "<script></script>");

    const symbols = await extractJsSymbols(dir, ["App.svelte"]);
    expect(symbols).toEqual({});
  });
});
