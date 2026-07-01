export interface RunPhaseOptions {
  cwd: string;
  model: string;
  prompt: string;
  lockedPaths?: string[];
  timeoutMs?: number;
}

export interface RunPhaseResult {
  success: boolean;
  resultText: string;
  durationMs: number;
}

export interface Backend {
  runPhase(opts: RunPhaseOptions): Promise<RunPhaseResult>;
}
