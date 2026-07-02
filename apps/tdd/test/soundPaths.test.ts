import { describe, expect, it } from "vitest";
import type { BaselineTestResult } from "../src/phases/baseline.js";
import { soundPaths } from "../src/soundPaths.js";

describe("soundPaths", () => {
  it("returns only paths with at least one pass and zero failures or errors", () => {
    const tests: BaselineTestResult[] = [
      { nodeId: "mixed.py::test_pass", outcome: "passed" },
      { nodeId: "mixed.py::test_fail", outcome: "failed" },
      { nodeId: "all_pass.py::test_a", outcome: "passed" },
      { nodeId: "all_pass.py::test_b", outcome: "passed" },
      { nodeId: "all_fail.py::test_x", outcome: "failed" },
      { nodeId: "all_fail.py::test_y", outcome: "error" },
    ];

    expect([...soundPaths(tests)].sort()).toEqual(["all_pass.py"]);
  });
});
