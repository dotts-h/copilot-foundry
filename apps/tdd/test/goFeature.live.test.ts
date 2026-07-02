import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ClaudeBackend } from "../src/backend/claudeBackend.js";
import { runCommand } from "../src/exec.js";
import { runFeature } from "../src/featureFsm.js";
import { DEFAULT_MODELS_BY_BACKEND, type FeatureRunSpec } from "../src/types.js";

const RUN_LIVE = process.env.RUN_CLAUDE_E2E === "1";
const GO_FIXTURE = join(process.cwd(), "fixtures", "go-add-kata");

async function seedTargetRepo(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "claude-go-e2e-"));
  cpSync(GO_FIXTURE, dir, { recursive: true });
  await runCommand("git", ["init", "-q"], { cwd: dir });
  await runCommand("git", ["config", "user.email", "t@e.c"], { cwd: dir });
  await runCommand("git", ["config", "user.name", "T"], { cwd: dir });
  await runCommand("git", ["add", "-A"], { cwd: dir });
  await runCommand("git", ["commit", "-q", "-m", "seed"], { cwd: dir });
  return dir;
}

describe.skipIf(!RUN_LIVE)("ClaudeBackend live E2E (go)", () => {
  let targetDir: string;
  let artifactRoot: string;

  afterEach(() => {
    if (targetDir) rmSync(targetDir, { recursive: true, force: true });
    if (artifactRoot) rmSync(artifactRoot, { recursive: true, force: true });
  });

  it("drives the full feature FSM to accepted on the go add kata", { timeout: 1_800_000 }, async () => {
    targetDir = await seedTargetRepo();
    artifactRoot = mkdtempSync(join(tmpdir(), "claude-go-e2e-artifacts-"));
    const spec: FeatureRunSpec = {
      mode: "feature",
      targetDir,
      language: "go",
      scope: "repo",
      hitl: "auto",
      featureDescription:
        "implement Add(a, b int) int in add_kata.go so it returns the sum of its two arguments",
      targetHint: "add_kata.go",
      models: DEFAULT_MODELS_BY_BACKEND.claude,
      maxRepairIterations: 3,
      commit: false,
    };

    const ledger = await runFeature(spec, new ClaudeBackend(), artifactRoot, "claude-go-live-1");

    expect(ledger.status).toBe("accepted");
    expect(ledger.workspace.branchName).toBe("helm-tdd/claude-go-live-1");
    const show = await runCommand("git", ["show", "helm-tdd/claude-go-live-1:add_kata.go"], { cwd: targetDir });
    expect(show.exitCode).toBe(0);
    expect(ledger.sliceResults.every((r) => r.refactorApplied === false)).toBe(true);
    const untouchedList = await runCommand("git", ["worktree", "list", "--porcelain"], { cwd: targetDir });
    expect(untouchedList.stdout.match(/^worktree /gm)?.length).toBe(1);
    const untouched = readFileSync(join(targetDir, "add_kata.go"), "utf8");
    expect(untouched).toContain("panic");
  });
});
