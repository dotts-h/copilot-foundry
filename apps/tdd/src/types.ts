export interface RunSpec {
  targetDir: string;
  venvDir: string;
  redModel: string;
  greenModel: string;
  implRelPath: string;
  testRelPath: string;
  redPrompt: string;
  greenPrompt: string;
}

export interface SliceLedger {
  runId: string;
  redSuccess: boolean;
  redGatePassed: boolean;
  greenSuccess: boolean;
  greenGatePassed: boolean;
  diffGuardViolated: boolean;
  diffGuardOffendingPaths: string[];
  completedAt: string;
}
