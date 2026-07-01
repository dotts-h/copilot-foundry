import { query } from "@anthropic-ai/claude-agent-sdk";
import type { Backend, RunPhaseOptions, RunPhaseResult } from "./types.js";
import { evaluateLeash } from "./claudeLeash.js";

const DEFAULT_TIMEOUT_MS = 300_000;
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
          if (msg.subtype === "success") {
            return { success: true, resultText: msg.result ?? "", durationMs: msg.duration_ms ?? 0 };
          }
          return { success: false, resultText: `claude-agent-sdk error: ${msg.subtype}`, durationMs: msg.duration_ms ?? 0 };
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
