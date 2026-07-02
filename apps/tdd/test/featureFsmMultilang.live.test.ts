import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ClaudeBackend } from "../src/backend/claudeBackend.js";
import { runCommand } from "../src/exec.js";
import { runFeature } from "../src/featureFsm.js";
import { DEFAULT_MODELS_BY_BACKEND, type FeatureRunSpec } from "../src/types.js";

const RUN_LIVE = process.env.RUN_CLAUDE_E2E === "1";
const KATA_TS = join(process.cwd(), "kata-ts");
const KATA_GO = join(process.cwd(), "kata-go");

async function seedKataRepo(fixtureDir: string): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "feature-fsm-multilang-live-"));
  cpSync(fixtureDir, dir, { recursive: true });
  await runCommand("git", ["init", "-q"], { cwd: dir });
  await runCommand("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  await runCommand("git", ["config", "user.name", "Test"], { cwd: dir });
  await runCommand("git", ["add", "-A"], { cwd: dir });
  await runCommand("git", ["commit", "-q", "-m", "seed"], { cwd: dir });
  return dir;
}

function assertAcceptedLedger(ledger: Awaited<ReturnType<typeof runFeature>>): void {
  expect(ledger.slices.length).toBeGreaterThanOrEqual(1);
  expect(ledger.status).toBe("accepted");
  for (const sliceResult of ledger.sliceResults) {
    expect(sliceResult.redGatePassed).toBe(true);
    expect(sliceResult.greenGatePassed).toBe(true);
  }
  expect(ledger.verifyResult?.passed).toBe(true);
  expect(ledger.acceptanceLedger?.overallAccepted).toBe(true);
  for (const sliceResult of ledger.sliceResults) {
    // js/go runners have no "constant" operator (it requires executing the target
    // function); the parity bar is: every APPLIED operator was killed.
    expect(sliceResult.mutationScore?.results.find((r) => r.operator === "constant")).toBeUndefined();
    expect(sliceResult.mutationScore?.score).toBe(1);
  }
  expect(ledger.writebackResult?.committed).toBe(false);
}

describe.skipIf(!RUN_LIVE)("runFeature (live E2E, multilang)", () => {
  let artifactRoot: string;

  beforeEach(() => {
    artifactRoot = mkdtempSync(join(tmpdir(), "feature-fsm-multilang-artifacts-"));
  });

  afterEach(() => {
    rmSync(artifactRoot, { recursive: true, force: true });
  });

  it("completes a kata-ts feature run with auto-detected js/vitest", async () => {
    const targetDir = await seedKataRepo(KATA_TS);
    try {
      const spec: FeatureRunSpec = {
        mode: "feature",
        targetDir,
        scope: "repo",
        hitl: "auto",
        featureDescription: "add a multiply function with tests",
        models: DEFAULT_MODELS_BY_BACKEND.claude,
        maxRepairIterations: 5,
        commit: false,
      };

      const ledger = await runFeature(spec, new ClaudeBackend(), artifactRoot, "run-feature-ts-live");
      assertAcceptedLedger(ledger);
    } finally {
      rmSync(targetDir, { recursive: true, force: true });
    }
  }, 900_000);

  it("completes a kata-go feature run with auto-detected go", async () => {
    const targetDir = await seedKataRepo(KATA_GO);
    try {
      const spec: FeatureRunSpec = {
        mode: "feature",
        targetDir,
        scope: "repo",
        hitl: "auto",
        featureDescription: "add a multiply function with tests",
        models: DEFAULT_MODELS_BY_BACKEND.claude,
        maxRepairIterations: 5,
        commit: false,
      };

      const ledger = await runFeature(spec, new ClaudeBackend(), artifactRoot, "run-feature-go-live");
      assertAcceptedLedger(ledger);
    } finally {
      rmSync(targetDir, { recursive: true, force: true });
    }
  }, 900_000);
});
