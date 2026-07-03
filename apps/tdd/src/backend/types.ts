export interface RunPhaseOptions {
  cwd: string;
  model: string;
  prompt: string;
  lockedPaths?: string[];
  timeoutMs?: number;
}

export interface PhaseDenial {
  tool: string;
  path?: string;
  reason: string;
}

export interface PhaseTelemetry {
  costUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
  turns?: number;
  denials: PhaseDenial[];
}

export interface RunPhaseResult {
  success: boolean;
  resultText: string;
  durationMs: number;
  telemetry: PhaseTelemetry;
}

export interface Backend {
  runPhase(opts: RunPhaseOptions): Promise<RunPhaseResult>;
}
