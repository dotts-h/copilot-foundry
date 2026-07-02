import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  goModulePath,
  goPathUnit,
  isGoMissingSymbolError,
  parseGoTestJson,
  runGoTest,
  runGoTestVerbose,
} from "../src/goRunner.js";

const FIXTURE = join(process.cwd(), "fixtures", "go-add-kata");

function copyFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "go-runner-"));
  cpSync(FIXTURE, dir, { recursive: true });
  return dir;
}

describe("parseGoTestJson", () => {
  it("parses a passing test event", () => {
    const raw = [
      '{"Action":"run","Package":"pkg","Test":"TestOk"}',
      '{"Action":"pass","Package":"pkg","Test":"TestOk","Elapsed":0}',
    ].join("\n");
    const { tests, buildFailed } = parseGoTestJson(raw);
    expect(tests).toEqual([{ nodeId: "pkg::TestOk", outcome: "passed" }]);
    expect(buildFailed).toBe(false);
  });

  it("parses a failing test event", () => {
    const raw = '{"Action":"fail","Package":"pkg","Test":"TestBad","Elapsed":0}';
    const { tests } = parseGoTestJson(raw);
    expect(tests).toEqual([{ nodeId: "pkg::TestBad", outcome: "failed" }]);
  });

  it("parses a skipped test event", () => {
    const raw = '{"Action":"skip","Package":"pkg","Test":"TestSkip","Elapsed":0}';
    const { tests } = parseGoTestJson(raw);
    expect(tests).toEqual([{ nodeId: "pkg::TestSkip", outcome: "skipped" }]);
  });

  it("flags buildFailed on a build-fail event", () => {
    const raw = '{"ImportPath":"pkg [pkg.test]","Action":"build-fail"}';
    const { tests, buildFailed } = parseGoTestJson(raw);
    expect(buildFailed).toBe(true);
    expect(tests).toEqual([]);
  });

  it("flags buildFailed when the raw output contains [build failed]", () => {
    const raw = '{"Action":"output","Package":"pkg","Output":"FAIL\\tpkg [build failed]\\n"}';
    expect(parseGoTestJson(raw).buildFailed).toBe(true);
  });

  it("ignores unparseable lines", () => {
    const raw = ["not json", '{"Action":"pass","Package":"pkg","Test":"TestOk","Elapsed":0}', ""].join(
      "\n",
    );
    expect(parseGoTestJson(raw).tests).toEqual([{ nodeId: "pkg::TestOk", outcome: "passed" }]);
  });

  it("returns no tests for a package with no test files", () => {
    const raw = [
      '{"Action":"start","Package":"pkg"}',
      '{"Action":"output","Package":"pkg","Output":"?   \\tpkg\\t[no test files]\\n"}',
      '{"Action":"skip","Package":"pkg","Elapsed":0}',
    ].join("\n");
    expect(parseGoTestJson(raw).tests).toEqual([]);
  });
});

describe("goPathUnit", () => {
  it("maps a root-level file to the module path", () => {
    expect(goPathUnit("go-add-kata", "add_kata.go")).toBe("go-add-kata");
  });

  it("maps a nested test file to module/dir", () => {
    expect(goPathUnit("go-add-kata", "internal/x/y_test.go")).toBe("go-add-kata/internal/x");
  });
});

describe("isGoMissingSymbolError", () => {
  it("matches a bare undefined symbol", () => {
    expect(isGoMissingSymbolError("./add_kata_test.go:6:12: undefined: Add", "Add")).toBe(true);
  });

  it("matches a package-qualified undefined symbol", () => {
    expect(isGoMissingSymbolError("undefined: pkg.Add", "Add")).toBe(true);
  });

  it("does not match a longer identifier sharing a prefix", () => {
    expect(isGoMissingSymbolError("undefined: Added", "Add")).toBe(false);
  });
});

describe("goModulePath", () => {
  it("reads the module path from go.mod", async () => {
    await expect(goModulePath(FIXTURE)).resolves.toBe("go-add-kata");
  });

  it("throws a clear error when go.mod is missing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "go-runner-nomod-"));
    try {
      await expect(goModulePath(dir)).rejects.toThrow(/go\.mod/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("go toolchain integration (fixture-backed)", () => {
  let dir: string;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("runGoTestVerbose returns no tests when the kata has no test file", async () => {
    dir = copyFixture();
    const { tests } = await runGoTestVerbose(dir);
    expect(tests).toEqual([]);
  });

  it("verdict is infra_error and flags the missing symbol when the test references an undefined function", async () => {
    dir = copyFixture();
    writeFileSync(
      join(dir, "add_kata_test.go"),
      'package addkata\n\nimport "testing"\n\nfunc TestSub(t *testing.T) {\n\tif got := Sub(5, 3); got != 2 {\n\t\tt.Fatalf("got %d", got)\n\t}\n}\n',
    );
    const { verdict, raw } = await runGoTest(dir);
    expect(verdict).toBe("infra_error");
    expect(isGoMissingSymbolError(raw, "Sub")).toBe(true);
  });

  it("verdict is tests_failed when a real test on Add fails", async () => {
    dir = copyFixture();
    writeFileSync(
      join(dir, "add_kata_test.go"),
      'package addkata\n\nimport "testing"\n\nfunc TestAdd(t *testing.T) {\n\tif got := Add(2, 3); got != 5 {\n\t\tt.Fatalf("got %d", got)\n\t}\n\tif got := Add(1, 1); got != 2 {\n\t\tt.Fatalf("got %d", got)\n\t}\n}\n',
    );
    const { verdict } = await runGoTest(dir);
    expect(verdict).toBe("tests_failed");
  });

  it("verdict is passed once Add is implemented correctly", async () => {
    dir = copyFixture();
    writeFileSync(
      join(dir, "add_kata_test.go"),
      'package addkata\n\nimport "testing"\n\nfunc TestAdd(t *testing.T) {\n\tif got := Add(2, 3); got != 5 {\n\t\tt.Fatalf("got %d", got)\n\t}\n\tif got := Add(1, 1); got != 2 {\n\t\tt.Fatalf("got %d", got)\n\t}\n}\n',
    );
    writeFileSync(join(dir, "add_kata.go"), "package addkata\n\nfunc Add(a, b int) int { return a + b }\n");
    const { verdict } = await runGoTest(dir);
    expect(verdict).toBe("passed");
  });

  it("scopes the run to the package containing targetRelPath", async () => {
    dir = copyFixture();
    writeFileSync(join(dir, "add_kata.go"), "package addkata\n\nfunc Add(a, b int) int { return a + b }\n");
    writeFileSync(
      join(dir, "add_kata_test.go"),
      'package addkata\n\nimport "testing"\n\nfunc TestAdd(t *testing.T) {\n\tif got := Add(2, 3); got != 5 {\n\t\tt.Fatalf("got %d", got)\n\t}\n}\n',
    );
    const { verdict } = await runGoTest(dir, "add_kata.go");
    expect(verdict).toBe("passed");
  });
});

describe("goRunner ENOENT handling", () => {
  it("surfaces a clear error when the go binary is not on PATH", async () => {
    const dir = mkdtempSync(join(tmpdir(), "go-runner-enoent-"));
    const originalPath = process.env.PATH;
    try {
      process.env.PATH = "";
      await expect(runGoTest(dir)).rejects.toThrow(/goRunner: the go toolchain was not found on PATH/);
    } finally {
      process.env.PATH = originalPath;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
