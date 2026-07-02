import { describe, expect, it } from "vitest";
import { computeScope } from "../../src/phases/scope.js";
import type { RepoMap } from "../../src/phases/map.js";

const MAP: RepoMap = {
  files: ["strings_kata.py", "test_strings_kata.py", "unrelated.py", "test_unrelated.py"],
  testFiles: ["test_strings_kata.py", "test_unrelated.py"],
  imports: {
    "test_strings_kata.py": ["strings_kata"],
    "test_unrelated.py": ["unrelated"],
  },
};

describe("computeScope", () => {
  it("defaults to the whole repo when no targetHint is given (conservative default)", () => {
    const report = computeScope(MAP, undefined, "node", "python");
    expect(report.inScope.sort()).toEqual([...MAP.files].sort());
    expect(report.reason).toMatch(/no targetHint/);
  });

  it("falls back to the whole repo when targetHint is not found in the map", () => {
    const report = computeScope(MAP, "does_not_exist.py", "node", "python");
    expect(report.inScope.sort()).toEqual([...MAP.files].sort());
    expect(report.reason).toMatch(/not found/);
  });

  it("scope=node includes the target plus its reverse-dependents (callers)", () => {
    const report = computeScope(MAP, "strings_kata.py", "node", "python");
    expect(report.inScope.sort()).toEqual(["strings_kata.py", "test_strings_kata.py"]);
    expect(report.inScope).not.toContain("unrelated.py");
  });

  it("scope=repo always returns every file regardless of targetHint", () => {
    const report = computeScope(MAP, "strings_kata.py", "repo", "python");
    expect(report.inScope.sort()).toEqual([...MAP.files].sort());
  });

  it("scope=package groups by containing directory", () => {
    const nestedMap: RepoMap = {
      files: ["pkg/a.py", "pkg/test_a.py", "other/b.py"],
      testFiles: ["pkg/test_a.py"],
      imports: {},
    };
    const report = computeScope(nestedMap, "pkg/a.py", "package", "python");
    expect(report.inScope.sort()).toEqual(["pkg/a.py", "pkg/test_a.py"]);
  });
});

const GO_MAP: RepoMap = {
  files: ["add_kata.go", "add_kata_test.go", "unrelated.go", "unrelated_test.go"],
  testFiles: ["add_kata_test.go", "unrelated_test.go"],
  imports: {
    "add_kata_test.go": ["go-add-kata"],
    "unrelated_test.go": ["go-add-kata/other"],
  },
  modulePath: "go-add-kata",
};

describe("computeScope (go)", () => {
  it("scope=node includes the target plus its reverse-dependents matched by exact import equality", () => {
    const report = computeScope(GO_MAP, "add_kata.go", "node", "go", "go-add-kata");
    expect(report.inScope.sort()).toEqual(["add_kata.go", "add_kata_test.go"]);
    expect(report.inScope).not.toContain("unrelated_test.go");
  });

  it("scope=repo always returns every file regardless of targetHint", () => {
    const report = computeScope(GO_MAP, "add_kata.go", "repo", "go", "go-add-kata");
    expect(report.inScope.sort()).toEqual([...GO_MAP.files].sort());
  });

  it("scope=package groups by containing directory", () => {
    const nestedMap: RepoMap = {
      files: ["pkg/a.go", "pkg/a_test.go", "other/b.go"],
      testFiles: ["pkg/a_test.go"],
      imports: {},
      modulePath: "example.com/m",
    };
    const report = computeScope(nestedMap, "pkg/a.go", "package", "go", "example.com/m");
    expect(report.inScope.sort()).toEqual(["pkg/a.go", "pkg/a_test.go"]);
  });

  it("throws a clear error when modulePath is missing for a non-package, non-repo scope", () => {
    expect(() => computeScope(GO_MAP, "add_kata.go", "node", "go")).toThrow(/modulePath/);
  });
});
