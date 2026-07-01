import { describe, expect, it } from "vitest";
import { buildAcceptanceLedger, type AcceptanceInputSlice } from "../../src/phases/accept.js";

const SLICE: AcceptanceInputSlice = {
  description: "add(a, b) returns a + b",
  implRelPath: "add_kata.py",
  testRelPath: "test_add_kata.py",
  redGatePassed: true,
  greenGatePassed: true,
  refactorApplied: true,
};

describe("buildAcceptanceLedger", () => {
  it("builds one traceability entry per slice, all accepted when everything passed", () => {
    const ledger = buildAcceptanceLedger("run-1", [SLICE], true);

    expect(ledger.runId).toBe("run-1");
    expect(ledger.entries).toHaveLength(1);
    expect(ledger.entries[0].sliceDescription).toBe(SLICE.description);
    expect(ledger.entries[0].verifyPassed).toBe(true);
    expect(ledger.overallAccepted).toBe(true);
  });

  it("marks overallAccepted false when verify failed, even if every slice's gates passed", () => {
    const ledger = buildAcceptanceLedger("run-2", [SLICE], false);
    expect(ledger.overallAccepted).toBe(false);
    expect(ledger.entries[0].verifyPassed).toBe(false);
  });

  it("marks overallAccepted false when any slice's gates did not pass", () => {
    const failedSlice: AcceptanceInputSlice = { ...SLICE, greenGatePassed: false };
    const ledger = buildAcceptanceLedger("run-3", [SLICE, failedSlice], true);
    expect(ledger.overallAccepted).toBe(false);
  });

  it("handles zero slices", () => {
    const ledger = buildAcceptanceLedger("run-4", [], true);
    expect(ledger.entries).toEqual([]);
    expect(ledger.overallAccepted).toBe(true);
  });
});
