import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTddMcpServer } from "../../src/mcp/server.js";

vi.mock("../../src/fsm.js", () => ({
  runSlice: vi.fn(
    () =>
      new Promise((resolve) => {
        setTimeout(
          () =>
            resolve({
              runId: "run-mocked",
              redSuccess: true,
              redGatePassed: true,
              greenSuccess: true,
              greenGatePassed: true,
              diffGuardViolated: false,
              diffGuardOffendingPaths: [],
              completedAt: new Date().toISOString(),
            }),
          300,
        );
      }),
  ),
}));

async function callTool(server: ReturnType<typeof createTddMcpServer>, name: string, args: unknown) {
  const registered = (server as unknown as { _registeredTools: Record<string, { handler: Function }> })
    ._registeredTools[name];
  return registered.handler(args, {});
}

describe("tdd MCP server", () => {
  let artifactRoot: string;

  beforeEach(() => {
    artifactRoot = mkdtempSync(join(tmpdir(), "mcp-server-test-"));
  });

  afterEach(() => {
    rmSync(artifactRoot, { recursive: true, force: true });
  });

  it("tdd_workflow_start returns a runId in well under a second, before the slice finishes", async () => {
    const server = createTddMcpServer({ artifactRoot });
    const startedAt = Date.now();
    const result = await callTool(server, "tdd_workflow_start", { targetDir: "/tmp/whatever" });
    const elapsedMs = Date.now() - startedAt;
    expect(elapsedMs).toBeLessThan(500);
    const parsed = JSON.parse(result.content[0].text);
    expect(typeof parsed.runId).toBe("string");
    expect(parsed.runId.length).toBeGreaterThan(0);
  });

  it("tdd_workflow_status reports running immediately after start, then done after the slice resolves", async () => {
    const server = createTddMcpServer({ artifactRoot });
    const startResult = await callTool(server, "tdd_workflow_start", { targetDir: "/tmp/whatever" });
    const { runId } = JSON.parse(startResult.content[0].text);

    const immediateStatus = JSON.parse(
      (await callTool(server, "tdd_workflow_status", { runId })).content[0].text,
    );
    expect(immediateStatus.status).toBe("running");

    await new Promise((resolve) => setTimeout(resolve, 500));

    const finalStatus = JSON.parse(
      (await callTool(server, "tdd_workflow_status", { runId })).content[0].text,
    );
    expect(finalStatus.status).toBe("done");
  });

  it("tdd_workflow_result returns the ledger once the run is done, and a pending marker before then", async () => {
    const server = createTddMcpServer({ artifactRoot });
    const startResult = await callTool(server, "tdd_workflow_start", { targetDir: "/tmp/whatever" });
    const { runId } = JSON.parse(startResult.content[0].text);

    const pending = JSON.parse((await callTool(server, "tdd_workflow_result", { runId })).content[0].text);
    expect(pending.status).toBe("running");

    await new Promise((resolve) => setTimeout(resolve, 500));

    const done = JSON.parse((await callTool(server, "tdd_workflow_result", { runId })).content[0].text);
    expect(done.status).toBe("done");
    expect(done.ledger.runId).toBe("run-mocked");
  });
});
