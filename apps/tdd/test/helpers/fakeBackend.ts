import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Backend, RunPhaseOptions, RunPhaseResult } from "../../src/backend/types.js";

type StepOutcome = { resultText?: string; success?: boolean; telemetry?: { denials: [] } } | void;
type Step = (opts: RunPhaseOptions) => Promise<StepOutcome> | StepOutcome;

export class ScriptedBackend implements Backend {
  private callIndex = 0;
  public readonly calls: RunPhaseOptions[] = [];

  constructor(private readonly script: Step[]) {
    if (script.length === 0) {
      throw new Error("ScriptedBackend: script must have at least one step");
    }
  }

  async runPhase(opts: RunPhaseOptions): Promise<RunPhaseResult> {
    this.calls.push(opts);
    const step = this.script[Math.min(this.callIndex, this.script.length - 1)];
    this.callIndex++;
    const outcome = await step(opts);
    return {
      success: outcome?.success ?? true,
      resultText: outcome?.resultText ?? "scripted",
      durationMs: 1,
      telemetry: outcome?.telemetry ?? { denials: [] },
    };
  }
}

export async function writeImpl(targetDir: string, relPath: string, content: string): Promise<void> {
  await writeFile(join(targetDir, relPath), content);
}
