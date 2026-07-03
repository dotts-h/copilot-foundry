import { query } from "@anthropic-ai/claude-agent-sdk";
import type { Backend, PhaseDenial, PhaseTelemetry, RunPhaseOptions, RunPhaseResult } from "./types.js";
import { evaluateLeash } from "./claudeLeash.js";

// A GREEN phase on a real repo runs the agent through repeated full test cycles
// (twiceshy: go test ./... is ~2min in a fresh worktree), so 300s aborted
// legitimately-progressing phases (run db559cf1 died at slice 6/9 GREEN).
const DEFAULT_TIMEOUT_MS = 900_000;
const MAX_TURNS = 40;

export class ClaudeBackend implements Backend {
  async runPhase(opts: RunPhaseOptions): Promise<RunPhaseResult> {
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const lockedPaths = opts.lockedPaths ?? [];
    try {
      // The SDK agent has no equivalent of cursor-agent's --workspace grounding; without this,
      // agents have been observed writing to absolute paths outside the workspace.
      const groundedPrompt =
        `You are working inside the repository at ${opts.cwd} (your current working directory). ` +
        "All file paths in the task below are relative to it. Never create or modify files outside it.\n\n" +
        opts.prompt;
      const denials: PhaseDenial[] = [];
      const stream = query({
        prompt: groundedPrompt,
        options: {
          cwd: opts.cwd,
          model: opts.model,
          maxTurns: MAX_TURNS,
          settingSources: [],
          permissionMode: "bypassPermissions",
          // bypassPermissions alone silently no-ops tool execution in the SDK; this flag is
          // required for it to take effect, and the PreToolUse deny hook still overrides it
          // (verified live 2026-07-01).
          allowDangerouslySkipPermissions: true,
          disallowedTools: ["WebFetch", "WebSearch"],
          abortController: controller,
          hooks: {
            PreToolUse: [
              {
                hooks: [
                  async (input) => {
                    const toolName = "tool_name" in input ? String(input.tool_name) : "";
                    const toolInput =
                      "tool_input" in input && input.tool_input !== null && typeof input.tool_input === "object"
                        ? (input.tool_input as Record<string, unknown>)
                        : {};
                    const decision = evaluateLeash(opts.cwd, lockedPaths, toolName, toolInput);
                    if (decision.deny) {
                      denials.push({
                        tool: toolName,
                        path: typeof toolInput.file_path === "string" ? toolInput.file_path : undefined,
                        reason: decision.reason ?? "path is leashed by helm-tdd",
                      });
                      return {
                        hookSpecificOutput: {
                          hookEventName: "PreToolUse" as const,
                          permissionDecision: "deny" as const,
                          permissionDecisionReason: decision.reason ?? "path is leashed by helm-tdd",
                        },
                      };
                    }
                    return {};
                  },
                ],
              },
            ],
          },
        },
      });

      for await (const msg of stream) {
        if (msg.type === "result") {
          const usage = "usage" in msg && msg.usage !== null && typeof msg.usage === "object" ? msg.usage : undefined;
          const telemetry: PhaseTelemetry = {
            costUsd: typeof msg.total_cost_usd === "number" ? msg.total_cost_usd : undefined,
            inputTokens:
              usage && typeof usage.input_tokens === "number" ? usage.input_tokens : undefined,
            outputTokens:
              usage && typeof usage.output_tokens === "number" ? usage.output_tokens : undefined,
            turns: typeof msg.num_turns === "number" ? msg.num_turns : undefined,
            denials,
          };
          if (msg.subtype === "success") {
            return { success: true, resultText: msg.result ?? "", durationMs: msg.duration_ms ?? 0, telemetry };
          }
          return {
            success: false,
            resultText: `claude-agent-sdk error: ${msg.subtype}`,
            durationMs: msg.duration_ms ?? 0,
            telemetry,
          };
        }
      }
      throw new Error("ClaudeBackend: query stream ended without a result message");
    } catch (err) {
      if (controller.signal.aborted) {
        throw new Error(`ClaudeBackend: phase timed out after ${timeoutMs}ms`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
}
