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
  symbols: {},
};

describe("computeScope", () => {
  it("defaults to the whole repo when no targetHint is given (conservative default)", () => {
    const report = computeScope(MAP, undefined, "node");
    expect(report.inScope.sort()).toEqual([...MAP.files].sort());
    expect(report.reason).toMatch(/no targetHint/);
  });

  it("falls back to the whole repo when targetHint is not found in the map", () => {
    const report = computeScope(MAP, "does_not_exist.py", "node");
    expect(report.inScope.sort()).toEqual([...MAP.files].sort());
    expect(report.reason).toMatch(/not found/);
  });

  it("scope=node includes the target plus its reverse-dependents (callers)", () => {
    const report = computeScope(MAP, "strings_kata.py", "node");
    expect(report.inScope.sort()).toEqual(["strings_kata.py", "test_strings_kata.py"]);
    expect(report.inScope).not.toContain("unrelated.py");
  });

  it("scope=repo always returns every file regardless of targetHint", () => {
    const report = computeScope(MAP, "strings_kata.py", "repo");
    expect(report.inScope.sort()).toEqual([...MAP.files].sort());
  });

  it("scope=package groups by containing directory", () => {
    const nestedMap: RepoMap = {
      files: ["pkg/a.py", "pkg/test_a.py", "other/b.py"],
      testFiles: ["pkg/test_a.py"],
      imports: {},
      symbols: {},
    };
    const report = computeScope(nestedMap, "pkg/a.py", "package");
    expect(report.inScope.sort()).toEqual(["pkg/a.py", "pkg/test_a.py"]);
  });
});
