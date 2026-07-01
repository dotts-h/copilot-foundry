import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ClaudeBackend } from "../src/backend/claudeBackend.js";
import { runCommand } from "../src/exec.js";
import { runFeature } from "../src/featureFsm.js";
import { DEFAULT_MODELS_BY_BACKEND, type FeatureRunSpec } from "../src/types.js";

const RUN_LIVE = process.env.RUN_CLAUDE_E2E === "1";
const FIXTURE_VENV = join(process.cwd(), "fixtures", "add-kata", ".venv");

async function seedTargetRepo(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "claude-e2e-"));
  writeFileSync(join(dir, "add_kata.py"), "def add(a, b):\n    raise NotImplementedError\n");
  await runCommand("git", ["init", "-q"], { cwd: dir });
  await runCommand("git", ["config", "user.email", "t@e.c"], { cwd: dir });
  await runCommand("git", ["config", "user.name", "T"], { cwd: dir });
  await runCommand("git", ["add", "-A"], { cwd: dir });
  await runCommand("git", ["commit", "-q", "-m", "seed"], { cwd: dir });
  return dir;
}

describe.skipIf(!RUN_LIVE)("ClaudeBackend live E2E", () => {
  let targetDir: string;
  let artifactRoot: string;

  afterEach(() => {
    if (targetDir) rmSync(targetDir, { recursive: true, force: true });
    if (artifactRoot) rmSync(artifactRoot, { recursive: true, force: true });
  });

  it("runs a trivial phase call and returns success", { timeout: 300_000 }, async () => {
    const backend = new ClaudeBackend();
    const dir = mkdtempSync(join(tmpdir(), "claude-ping-"));
    const result = await backend.runPhase({
      cwd: dir,
      model: "claude-sonnet-5",
      prompt: "Reply with exactly the word OK and nothing else. Do not use any tools.",
    });
    rmSync(dir, { recursive: true, force: true });
    expect(result.success).toBe(true);
    expect(result.resultText).toContain("OK");
  });

  it("drives the full feature FSM to accepted on the add kata", { timeout: 1_800_000 }, async () => {
    targetDir = await seedTargetRepo();
    artifactRoot = mkdtempSync(join(tmpdir(), "claude-e2e-artifacts-"));
    const spec: FeatureRunSpec = {
      mode: "feature",
      targetDir,
      venvDir: FIXTURE_VENV,
      scope: "repo",
      hitl: "auto",
      featureDescription:
        "implement add(a, b) in add_kata.py so it returns the sum of its two integer arguments",
      targetHint: "add_kata.py",
      models: DEFAULT_MODELS_BY_BACKEND.claude,
      maxRepairIterations: 3,
      commit: false,
    };

    const ledger = await runFeature(spec, new ClaudeBackend(), artifactRoot, "claude-live-1");

    expect(ledger.status).toBe("accepted");
    expect(ledger.workspace.branchName).toBe("helm-tdd/claude-live-1");
    const show = await runCommand("git", ["show", "helm-tdd/claude-live-1:add_kata.py"], { cwd: targetDir });
    expect(show.exitCode).toBe(0);
    const untouchedList = await runCommand("git", ["worktree", "list", "--porcelain"], { cwd: targetDir });
    expect(untouchedList.stdout.match(/^worktree /gm)?.length).toBe(1);
    expect(ledger.sliceResults.every((r) => !r.diffGuardViolated)).toBe(true);
  });
});
