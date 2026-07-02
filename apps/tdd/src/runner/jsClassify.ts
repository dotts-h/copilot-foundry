import type { RunClassification, TestRunResult } from "./types.js";

export const VITEST_HARNESS_ERROR_MARKERS = [
  "Failed to load",
  "Transform failed",
  "FAILED to collect",
  "Error: Failed to resolve import",
] as const;

export const JEST_HARNESS_ERROR_MARKERS = ["Test suite failed to run"] as const;

function hasVitestHarnessMarker(raw: string): boolean {
  if (VITEST_HARNESS_ERROR_MARKERS.some((marker) => raw.includes(marker))) {
    return true;
  }
  return raw.includes("SyntaxError:") && raw.includes("Failed");
}

export function classifyJsRun(framework: "vitest" | "jest", result: TestRunResult): RunClassification {
  if (result.exitCode === 0) return "passed";
  if (result.exitCode === 1) {
    const markers =
      framework === "vitest"
        ? hasVitestHarnessMarker(result.raw)
        : JEST_HARNESS_ERROR_MARKERS.some((m) => result.raw.includes(m));
    return markers ? "harness_error" : "failed";
  }
  return "harness_error";
}
