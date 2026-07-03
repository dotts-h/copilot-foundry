import { beforeEach, describe, expect, it, vi } from "vitest";
import { ClaudeBackend } from "../../src/backend/claudeBackend.js";

const queryMock = vi.fn();

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: (...args: unknown[]) => queryMock(...args),
}));

type QueryArgs = {
  options: {
    hooks: {
      PreToolUse: Array<{ hooks: Array<(input: Record<string, unknown>) => Promise<unknown>> }>;
    };
  };
};

describe("ClaudeBackend (unit)", () => {
  beforeEach(() => {
    queryMock.mockReset();
  });

  it("records a leash denial in telemetry when PreToolUse denies", async () => {
    queryMock.mockImplementation((args: QueryArgs) =>
      (async function* () {
        const hook = args.options.hooks.PreToolUse[0].hooks[0];
        await hook({
          tool_name: "Write",
          tool_input: { file_path: "tests/locked.py" },
        });
        yield {
          type: "result",
          subtype: "success",
          result: "done",
          duration_ms: 50,
          total_cost_usd: 0.01,
        };
      })(),
    );

    const backend = new ClaudeBackend();
    const result = await backend.runPhase({
      cwd: "/work/repo",
      model: "claude-sonnet-5",
      prompt: "test",
      lockedPaths: ["tests/locked.py"],
    });

    expect(result.telemetry.denials).toHaveLength(1);
    expect(result.telemetry.denials[0]).toMatchObject({
      tool: "Write",
      path: "tests/locked.py",
      reason: expect.stringContaining("leash"),
    });
  });

  it("maps result message cost and usage onto telemetry", async () => {
    queryMock.mockImplementation(() =>
      (async function* () {
        yield {
          type: "result",
          subtype: "success",
          result: "ok",
          duration_ms: 100,
          total_cost_usd: 1.23,
          usage: { input_tokens: 100, output_tokens: 50 },
          num_turns: 3,
        };
      })(),
    );

    const backend = new ClaudeBackend();
    const result = await backend.runPhase({
      cwd: "/tmp",
      model: "claude-sonnet-5",
      prompt: "test",
    });

    expect(result.telemetry.costUsd).toBe(1.23);
    expect(result.telemetry.inputTokens).toBe(100);
    expect(result.telemetry.outputTokens).toBe(50);
    expect(result.telemetry.turns).toBe(3);
    expect(result.telemetry.denials).toEqual([]);
  });
});
