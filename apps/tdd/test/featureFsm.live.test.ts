import { mkdtempSync, rmSync } from "node:fs";
import { cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCommand } from "../src/exec.js";
import { CursorBackend } from "../src/backend/cursorBackend.js";
import { runFeature } from "../src/featureFsm.js";
import { DEFAULT_MODELS, type FeatureRunSpec } from "../src/types.js";

const RUN_LIVE = process.env.RUN_CURSOR_E2E === "1";
const FIXTURE = join(process.cwd(), "fixtures", "strings-kata");

async function seedTargetRepo(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "feature-fsm-live-"));
  cpSync(join(FIXTURE, "strings_kata.py"), join(dir, "strings_kata.py"));
  await runCommand("git", ["init", "-q"], { cwd: dir });
  await runCommand("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  await runCommand("git", ["config", "user.name", "Test"], { cwd: dir });
  await runCommand("git", ["add", "-A"], { cwd: dir });
  await runCommand("git", ["commit", "-q", "-m", "seed"], { cwd: dir });
  return dir;
}

describe.skipIf(!RUN_LIVE)("runFeature (live E2E, feature mode)", () => {
  let targetDir: string;
  let artifactRoot: string;

  beforeEach(async () => {
    targetDir = await seedTargetRepo();
    artifactRoot = mkdtempSync(join(tmpdir(), "feature-fsm-live-artifacts-"));
  });

  afterEach(() => {
    rmSync(targetDir, { recursive: true, force: true });
    rmSync(artifactRoot, { recursive: true, force: true });
  });

  it("plans and completes a real multi-slice feature run against strings-kata using real cursor-agent calls", async () => {
    const spec: FeatureRunSpec = {
      mode: "feature",
      targetDir,
      venvDir: join(FIXTURE, ".venv"),
      scope: "repo",
      hitl: "auto",
      featureDescription:
        "Implement two string utilities in strings_kata.py: reverse_words(s), which reverses the order " +
        "of whitespace-separated words in s, and is_palindrome(s), which returns True iff s reads the " +
        "same forwards and backwards. Plan them as two separate slices.",
      models: DEFAULT_MODELS,
      maxRepairIterations: 5,
      commit: false,
    };

    const ledger = await runFeature(spec, new CursorBackend(), artifactRoot, "run-feature-live");

    expect(ledger.slices.length).toBeGreaterThanOrEqual(1);
    expect(ledger.status).toBe("accepted");
    for (const sliceResult of ledger.sliceResults) {
      expect(sliceResult.redGatePassed).toBe(true);
      expect(sliceResult.greenGatePassed).toBe(true);
    }
    expect(ledger.verifyResult?.passed).toBe(true);
    expect(ledger.acceptanceLedger?.overallAccepted).toBe(true);
    for (const sliceResult of ledger.sliceResults) {
      expect(sliceResult.mutationScore?.results.find((r) => r.operator === "constant")?.survived).toBe(false);
    }
    expect(ledger.writebackResult?.committed).toBe(false);
  }, 900_000);
});
