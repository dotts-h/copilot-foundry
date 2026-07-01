import { runCommand } from "../exec.js";
import { removeLeashConfig, writeLeashConfig } from "./cursorLeash.js";
import type { Backend, RunPhaseOptions, RunPhaseResult } from "./types.js";

interface CursorAgentResult {
  type: "result";
  is_error?: boolean;
  result?: string;
  duration_ms?: number;
}

export class CursorBackend implements Backend {
  async runPhase(opts: RunPhaseOptions): Promise<RunPhaseResult> {
    const locked = opts.lockedPaths ?? [];
    if (locked.length > 0) await writeLeashConfig(opts.cwd, locked);
    try {
      const { stdout, stderr } = await runCommand(
        "cursor-agent",
        [
          "-p",
          "--output-format",
          "json",
          "--force",
          "--trust",
          "--model",
          opts.model,
          "--workspace",
          opts.cwd,
          opts.prompt,
        ],
        { cwd: opts.cwd, timeoutMs: opts.timeoutMs ?? 180_000 },
      );

      const parsed = stdout
        .split("\n")
        .filter((line) => line.trim().startsWith("{"))
        .map((line) => {
          try {
            return JSON.parse(line) as CursorAgentResult;
          } catch {
            return null;
          }
        })
        .filter((value): value is CursorAgentResult => value !== null)
        .at(-1);

      if (!parsed) {
        throw new Error(
          `CursorBackend: no JSON result line found in cursor-agent output.\nstdout:\n${stdout}\nstderr:\n${stderr}`,
        );
      }

      return {
        success: parsed.is_error !== true,
        resultText: parsed.result ?? "",
        durationMs: parsed.duration_ms ?? 0,
      };
    } finally {
      if (locked.length > 0) await removeLeashConfig(opts.cwd);
    }
  }
}
