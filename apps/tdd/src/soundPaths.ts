import type { BaselineTestResult } from "./phases/baseline.js";

/** Paths with ≥1 passing test and 0 failed/error tests in the scan. */
export function soundPaths(tests: BaselineTestResult[]): Set<string> {
  const passingPaths = new Set<string>();
  const failingPaths = new Set<string>();
  for (const t of tests) {
    const path = t.nodeId.split("::")[0];
    if (t.outcome === "passed") {
      passingPaths.add(path);
    } else if (t.outcome === "failed" || t.outcome === "error") {
      failingPaths.add(path);
    }
  }
  return new Set([...passingPaths].filter((path) => !failingPaths.has(path)));
}
