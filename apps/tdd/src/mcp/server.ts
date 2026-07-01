import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { readArtifact } from "../artifacts/vault.js";
import { CursorBackend } from "../backend/cursorBackend.js";
import { runFeature, type FeatureLedger } from "../featureFsm.js";
import { readRunState, writeRunState } from "../runStore.js";
import { DEFAULT_MODELS, type FeatureRunSpec, type ModelRouting } from "../types.js";

export function createTddMcpServer(deps: { artifactRoot: string }): McpServer {
  const server = new McpServer({ name: "helm-tdd", version: "0.1.0" });

  server.registerTool(
    "tdd_workflow_start",
    {
      description:
        "Start a helm-tdd feature-mode run (map->baseline->scope->plan->RED/GREEN slice loop). " +
        "Returns immediately with a runId; poll tdd_workflow_status/tdd_workflow_result.",
      inputSchema: {
        targetDir: z.string(),
        venvDir: z.string(),
        featureDescription: z.string(),
        scope: z.enum(["node", "module", "package", "repo"]).default("repo"),
        hitl: z.enum(["plan-only", "auto"]).default("auto"),
        targetHint: z.string().optional(),
        maxRepairIterations: z.number().int().min(1).max(10).default(5),
        commit: z.boolean().default(false),
        models: z
          .object({
            plan: z.string().optional(),
            red: z.string().optional(),
            green: z.string().optional(),
            escalation: z.string().optional(),
          })
          .optional(),
      },
    },
    async ({
      targetDir,
      venvDir,
      featureDescription,
      scope,
      hitl,
      targetHint,
      maxRepairIterations,
      commit,
      models,
    }) => {
      const runId = randomUUID();
      const startedAt = new Date().toISOString();
      await writeRunState(deps.artifactRoot, runId, {
        status: "running",
        progress: { phase: "map" },
        startedAt,
        updatedAt: startedAt,
      });

      const resolvedModels: ModelRouting = {
        plan: models?.plan ?? DEFAULT_MODELS.plan,
        red: models?.red ?? DEFAULT_MODELS.red,
        green: models?.green ?? DEFAULT_MODELS.green,
        escalation: models?.escalation ?? DEFAULT_MODELS.escalation,
      };

      const spec: FeatureRunSpec = {
        mode: "feature",
        targetDir,
        venvDir,
        scope,
        hitl,
        featureDescription,
        targetHint,
        models: resolvedModels,
        maxRepairIterations,
        commit,
      };

      runFeature(spec, new CursorBackend(), deps.artifactRoot, runId).catch(async (err) => {
        await writeRunState(deps.artifactRoot, runId, {
          status: "error",
          progress: { phase: "error" },
          error: String(err),
          startedAt,
          updatedAt: new Date().toISOString(),
        });
      });

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
      const state = await readRunState(deps.artifactRoot, runId);
      return { content: [{ type: "text" as const, text: JSON.stringify(state ?? { status: "unknown" }) }] };
    },
  );

  server.registerTool(
    "tdd_workflow_result",
    {
      description: "Fetch the ledger for a completed helm-tdd run.",
      inputSchema: { runId: z.string() },
    },
    async ({ runId }) => {
      const state = await readRunState(deps.artifactRoot, runId);
      if (!state || state.status === "running") {
        return { content: [{ type: "text" as const, text: JSON.stringify({ status: state?.status ?? "unknown" }) }] };
      }
      if (state.status === "error") {
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ status: "error", error: state.error }) }],
        };
      }
      const ledger = await readArtifact<FeatureLedger>(deps.artifactRoot, runId, "featureLedger");
      return { content: [{ type: "text" as const, text: JSON.stringify({ status: "done", ledger }) }] };
    },
  );

  return server;
}
