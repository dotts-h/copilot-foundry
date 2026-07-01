export interface AcceptanceInputSlice {
  description: string;
  implRelPath: string;
  testRelPath: string;
  redGatePassed: boolean;
  greenGatePassed: boolean;
  refactorApplied: boolean;
}

export interface AcceptanceEntry {
  sliceDescription: string;
  implRelPath: string;
  testRelPath: string;
  redGatePassed: boolean;
  greenGatePassed: boolean;
  refactorApplied: boolean;
  verifyPassed: boolean;
}

export interface AcceptanceLedger {
  runId: string;
  entries: AcceptanceEntry[];
  overallAccepted: boolean;
}

export function buildAcceptanceLedger(
  runId: string,
  slices: AcceptanceInputSlice[],
  verifyPassed: boolean,
): AcceptanceLedger {
  const entries: AcceptanceEntry[] = slices.map((s) => ({
    sliceDescription: s.description,
    implRelPath: s.implRelPath,
    testRelPath: s.testRelPath,
    redGatePassed: s.redGatePassed,
    greenGatePassed: s.greenGatePassed,
    refactorApplied: s.refactorApplied,
    verifyPassed,
  }));

  const overallAccepted = verifyPassed && entries.every((e) => e.redGatePassed && e.greenGatePassed);

  return { runId, entries, overallAccepted };
}
