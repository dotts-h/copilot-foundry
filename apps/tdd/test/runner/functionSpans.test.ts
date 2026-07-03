import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createGoRunner } from "../../src/runner/goRunner.js";
import { extractJsFunctionSpans } from "../../src/runner/jsSymbols.js";
import { createPythonRunner } from "../../src/runner/pythonRunner.js";

const FIXTURE_VENV = join(process.cwd(), "fixtures", "add-kata", ".venv");

describe("functionSpans", () => {
  let dir: string;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  describe("python", () => {
    const runner = createPythonRunner(FIXTURE_VENV);

    it("returns exact spans for two functions and one class method", async () => {
      dir = mkdtempSync(join(tmpdir(), "fn-spans-py-"));
      const filePath = join(dir, "sample.py");
      writeFileSync(
        filePath,
        [
          "def alpha():",
          "    return 1",
          "",
          "def beta():",
          "    x = 2",
          "    return x",
          "",
          "class Widget:",
          "    def spin(self):",
          "        pass",
        ].join("\n"),
      );

      const spans = await runner.functionSpans(filePath);
      expect(spans).toEqual([
        { name: "alpha", startLine: 1, endLine: 2 },
        { name: "beta", startLine: 4, endLine: 6 },
        { name: "spin", startLine: 9, endLine: 10 },
      ]);
    });

    it("returns [] for syntactically broken source", async () => {
      dir = mkdtempSync(join(tmpdir(), "fn-spans-py-broken-"));
      const filePath = join(dir, "broken.py");
      writeFileSync(filePath, "def oops(:\n");

      expect(await runner.functionSpans(filePath)).toEqual([]);
    });
  });

  describe("js", () => {
    it("returns exact spans for a function declaration and a const arrow", async () => {
      dir = mkdtempSync(join(tmpdir(), "fn-spans-js-"));
      const filePath = join(dir, "sample.ts");
      writeFileSync(
        filePath,
        [
          "function one() {",
          "  return 1;",
          "}",
          "",
          "const two = () => {",
          "  return 2;",
          "};",
        ].join("\n"),
      );

      const spans = await extractJsFunctionSpans(filePath);
      expect(spans).toEqual([
        { name: "one", startLine: 1, endLine: 3 },
        { name: "two", startLine: 5, endLine: 7 },
      ]);
    });

    it("returns [] for syntactically broken source", async () => {
      dir = mkdtempSync(join(tmpdir(), "fn-spans-js-broken-"));
      const filePath = join(dir, "broken.ts");
      writeFileSync(filePath, "function {{{");

      expect(await extractJsFunctionSpans(filePath)).toEqual([]);
    });
  });

  describe("go", () => {
    const runner = createGoRunner("/tmp");

    it("returns exact spans for two functions and one receiver method", async () => {
      dir = mkdtempSync(join(tmpdir(), "fn-spans-go-"));
      const filePath = join(dir, "sample.go");
      writeFileSync(
        filePath,
        [
          "package sample",
          "",
          "func Alpha() int {",
          "\treturn 1",
          "}",
          "",
          "func Beta() int {",
          "\treturn 2",
          "}",
          "",
          "type Widget struct{}",
          "",
          "func (w Widget) Spin() {}",
        ].join("\n"),
      );

      const spans = await runner.functionSpans(filePath);
      expect(spans).toEqual([
        { name: "Alpha", startLine: 3, endLine: 5 },
        { name: "Beta", startLine: 7, endLine: 9 },
        { name: "Spin", startLine: 13, endLine: 13 },
      ]);
    });

    it("returns [] for syntactically broken source", async () => {
      dir = mkdtempSync(join(tmpdir(), "fn-spans-go-broken-"));
      const filePath = join(dir, "broken.go");
      writeFileSync(filePath, "package broken\n\nfunc oops( {\n");

      expect(await runner.functionSpans(filePath)).toEqual([]);
    });
  });
});
