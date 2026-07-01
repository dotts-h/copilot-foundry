import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTddMcpServer } from "../../src/mcp/server.js";

vi.mock("../../src/featureFsm.js", () => ({
  runFeature: vi.fn(async (_spec: unknown, _backend: unknown, artifactRoot: string, runId: string) => {
    await new Promise((resolve) => setTimeout(resolve, 300));
    const { writeArtifact } = await import("../../src/artifacts/vault.js");
    const { writeRunState } = await import("../../src/runStore.js");
    const ledger = {
      runId,
      mode: "feature" as const,
      mapSummary: { fileCount: 1, testFileCount: 0 },
      baselineSummary: { total: 0, passed: 0, failed: 0 },
      scopeReport: { inScope: [], reason: "test" },
      slices: [],
      sliceResults: [],
      status: "completed" as const,
      completedAt: new Date().toISOString(),
    };
    await writeArtifact(artifactRoot, runId, "featureLedger", ledger);
    await writeRunState(artifactRoot, runId, {
      status: "done",
      progress: { phase: "done" },
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    return ledger;
  }),
}));

async function callTool(server: ReturnType<typeof createTddMcpServer>, name: string, args: unknown) {
  const registered = (server as unknown as { _registeredTools: Record<string, { handler: Function }> })
    ._registeredTools[name];
  return registered.handler(args, {});
}

const BASE_ARGS = {
  targetDir: "/tmp/whatever",
  venvDir: "/tmp/whatever/.venv",
  featureDescription: "add string utilities",
  scope: "repo" as const,
  hitl: "auto" as const,
  maxRepairIterations: 5,
};

describe("tdd MCP server (feature mode)", () => {
  let artifactRoot: string;

  beforeEach(() => {
    artifactRoot = mkdtempSync(join(tmpdir(), "mcp-server-test-"));
  });

  afterEach(() => {
    rmSync(artifactRoot, { recursive: true, force: true });
  });

  it("tdd_workflow_start returns a runId in well under a second, before the run finishes", async () => {
    const server = createTddMcpServer({ artifactRoot });
    const startedAt = Date.now();
    const result = await callTool(server, "tdd_workflow_start", BASE_ARGS);
    const elapsedMs = Date.now() - startedAt;
    expect(elapsedMs).toBeLessThan(500);
    const parsed = JSON.parse(result.content[0].text);
    expect(typeof parsed.runId).toBe("string");
    expect(parsed.runId.length).toBeGreaterThan(0);
  });

  it("tdd_workflow_status reports running immediately, then done once the run finishes -- backed by disk, not memory", async () => {
    const server = createTddMcpServer({ artifactRoot });
    const startResult = await callTool(server, "tdd_workflow_start", BASE_ARGS);
    const { runId } = JSON.parse(startResult.content[0].text);

    const immediate = JSON.parse((await callTool(server, "tdd_workflow_status", { runId })).content[0].text);
    expect(immediate.status).toBe("running");

    await new Promise((resolve) => setTimeout(resolve, 500));

    const final = JSON.parse((await callTool(server, "tdd_workflow_status", { runId })).content[0].text);
    expect(final.status).toBe("done");

    const rehydratedServer = createTddMcpServer({ artifactRoot });
    const rehydrated = JSON.parse(
      (await callTool(rehydratedServer, "tdd_workflow_status", { runId })).content[0].text,
    );
    expect(rehydrated.status).toBe("done");
  });

  it("tdd_workflow_result returns the ledger once done, even from a brand-new server instance", async () => {
    const server = createTddMcpServer({ artifactRoot });
    const startResult = await callTool(server, "tdd_workflow_start", BASE_ARGS);
    const { runId } = JSON.parse(startResult.content[0].text);

    await new Promise((resolve) => setTimeout(resolve, 500));

    const freshServer = createTddMcpServer({ artifactRoot });
    const done = JSON.parse((await callTool(freshServer, "tdd_workflow_result", { runId })).content[0].text);
    expect(done.status).toBe("done");
    expect(done.ledger.runId).toBe(runId);
  });

  it("tdd_workflow_result reports a pending marker before the run finishes", async () => {
    const server = createTddMcpServer({ artifactRoot });
    const startResult = await callTool(server, "tdd_workflow_start", BASE_ARGS);
    const { runId } = JSON.parse(startResult.content[0].text);

    const pending = JSON.parse((await callTool(server, "tdd_workflow_result", { runId })).content[0].text);
    expect(pending.status).toBe("running");
  });
});
