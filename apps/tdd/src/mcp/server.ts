import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { CursorBackend } from "../backend/cursorBackend.js";
import { runSlice } from "../fsm.js";
import type { RunSpec, SliceLedger } from "../types.js";

interface RunState {
  status: "running" | "done" | "error";
  ledger?: SliceLedger;
  error?: string;
}

export function createTddMcpServer(deps: { artifactRoot: string }): McpServer {
  const server = new McpServer({ name: "helm-tdd-m0", version: "0.0.0" });
  const runs = new Map<string, RunState>();

  function buildRunSpec(targetDir: string): RunSpec {
    return {
      targetDir,
      venvDir: join(import.meta.dirname, "..", "..", "fixtures", "add-kata", ".venv"),
      redModel: "claude-sonnet-5-thinking-medium",
      greenModel: "composer-2.5-fast",
      implRelPath: "add_kata.py",
      testRelPath: "test_add_kata.py",
      redPrompt:
        "Write ONLY a failing pytest test at test_add_kata.py for a function add(a, b) in add_kata.py " +
        "that should return a + b (e.g. assert add(2, 3) == 5). Do NOT implement or modify add_kata.py. " +
        "Do not create or modify any other file.",
      greenPrompt:
        "The test at test_add_kata.py is currently failing. Make it pass with the minimal correct " +
        "implementation of add in add_kata.py. Do NOT modify test_add_kata.py under any circumstances " +
        "-- it is locked and any attempt to edit it will be reverted and the slice will fail.",
    };
  }

  server.registerTool(
    "tdd_workflow_start",
    {
      description:
        "Start a helm-tdd RED->GREEN slice run. Returns immediately with a runId; " +
        "poll tdd_workflow_status/tdd_workflow_result.",
      inputSchema: { targetDir: z.string() },
    },
    async ({ targetDir }) => {
      const runId = randomUUID();
      runs.set(runId, { status: "running" });

      const spec = buildRunSpec(targetDir);
      runSlice(spec, new CursorBackend(), deps.artifactRoot, runId)
        .then((ledger) => runs.set(runId, { status: "done", ledger }))
        .catch((err) => runs.set(runId, { status: "error", error: String(err) }));

      return { content: [{ type: "text" as const, text: JSON.stringify({ runId }) }] };
    },
  );

  server.registerTool(
    "tdd_workflow_status",
    {
      description: "Poll the status of a helm-tdd run started via tdd_workflow_start.",
      inputSchema: { runId: z.string() },
    },
    async ({ runId }) => {
      const entry = runs.get(runId);
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ status: entry?.status ?? "unknown" }) }],
      };
    },
  );

  server.registerTool(
    "tdd_workflow_result",
    {
      description: "Fetch the ledger for a completed helm-tdd run.",
      inputSchema: { runId: z.string() },
    },
    async ({ runId }) => {
      const entry = runs.get(runId);
      if (!entry || entry.status === "running") {
        return { content: [{ type: "text" as const, text: JSON.stringify({ status: "running" }) }] };
      }
      if (entry.status === "error") {
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ status: "error", error: entry.error }) }],
        };
      }
      return {
        content: [
          { type: "text" as const, text: JSON.stringify({ status: "done", ledger: entry.ledger }) },
        ],
      };
    },
  );

  return server;
}
