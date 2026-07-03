#!/usr/bin/env node
/**
 * Manual eval driver for helm-tdd prompt-content experiments.
 * Imports compiled dist output — run `npm run build` in apps/tdd first.
 */
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runCommand } from "../dist/exec.js";
import { runFeature } from "../dist/featureFsm.js";
import { ClaudeBackend } from "../dist/backend/claudeBackend.js";
import { CursorBackend } from "../dist/backend/cursorBackend.js";
import { DEFAULT_MODELS_BY_BACKEND } from "../dist/types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const ARM_B_FRAGMENTS = {
  py: "When the behavior has three or more input cases, write ONE parametrized test (@pytest.mark.parametrize) listing the cases, instead of near-identical separate tests. Assert only on observable behavior (return values, raised exceptions), never on internals.",
  js: "When the behavior has three or more input cases, write ONE test.each table listing the cases, instead of near-identical separate tests. Assert only on observable behavior (return values, thrown errors), never on internals.",
  go: "When the behavior has three or more input cases, write ONE table-driven test (a []struct case slice) instead of near-identical separate test functions. Assert only on observable behavior (return values, errors), never on internals.",
};

const LANGUAGE_TO_FOLDER = { py: "python", js: "js", go: "go" };
const LANGUAGE_TO_RUNNER = { py: "python", js: "js", go: "go" };

function parseArgs(argv) {
  const opts = {
    arm: undefined,
    language: undefined,
    feature: undefined,
    reps: 1,
    backend: "cursor",
    exp: undefined,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--arm") opts.arm = argv[++i];
    else if (arg === "--language") opts.language = argv[++i];
    else if (arg === "--feature") opts.feature = argv[++i];
    else if (arg === "--reps") opts.reps = Number(argv[++i]);
    else if (arg === "--backend") opts.backend = argv[++i];
    else if (arg === "--exp") opts.exp = argv[++i];
    else if (arg === "--help" || arg === "-h") opts.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return opts;
}

function usage() {
  return `Usage: node eval/run-eval.mjs --arm A|B --language py|js|go --feature <key> [--reps N] [--backend cursor|claude] [--exp <name>]

Requires: npm run build in apps/tdd (imports from dist/).
`;
}

async function seedFixture(fixtureDir) {
  const dir = mkdtempSync(join(tmpdir(), "helm-tdd-eval-"));
  cpSync(fixtureDir, dir, { recursive: true });
  await runCommand("git", ["init", "-q"], { cwd: dir });
  await runCommand("git", ["config", "user.email", "eval@helm-tdd.local"], { cwd: dir });
  await runCommand("git", ["config", "user.name", "helm-tdd-eval"], { cwd: dir });
  await runCommand("git", ["add", "-A"], { cwd: dir });
  await runCommand("git", ["commit", "-q", "-m", "seed"], { cwd: dir });
  return dir;
}

function serializePerSlice(sliceResults) {
  return sliceResults.map((slice) => ({
    mutationScore: slice.mutationScore?.score ?? null,
    redLint: slice.redLint,
    greenIterationsUsed: slice.greenIterationsUsed,
    refactorScopeViolation: slice.refactorScopeViolation,
  }));
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(usage());
    process.exit(0);
  }

  if (!opts.arm || !["A", "B"].includes(opts.arm)) {
    console.error("error: --arm A|B is required");
    console.error(usage());
    process.exit(1);
  }
  if (!opts.language || !LANGUAGE_TO_FOLDER[opts.language]) {
    console.error("error: --language py|js|go is required");
    console.error(usage());
    process.exit(1);
  }
  if (!opts.feature) {
    console.error("error: --feature <key> is required");
    console.error(usage());
    process.exit(1);
  }
  if (!Number.isFinite(opts.reps) || opts.reps < 1) {
    console.error("error: --reps must be a positive integer");
    process.exit(1);
  }
  if (!["cursor", "claude"].includes(opts.backend)) {
    console.error("error: --backend cursor|claude");
    process.exit(1);
  }

  const features = JSON.parse(readFileSync(join(__dirname, "features.json"), "utf8"));
  const featureEntry = features[opts.feature];
  if (!featureEntry) {
    console.error(`error: unknown feature key "${opts.feature}"`);
    process.exit(1);
  }

  const featureDescription = featureEntry.description[opts.language];
  if (!featureDescription) {
    console.error(`error: feature "${opts.feature}" has no description for language "${opts.language}"`);
    process.exit(1);
  }

  const expName = opts.exp ?? new Date().toISOString().replace(/[:.]/g, "-");
  const resultsDir = join(__dirname, "results", expName);
  mkdirSync(resultsDir, { recursive: true });

  const fixtureDir = join(__dirname, "fixtures", LANGUAGE_TO_FOLDER[opts.language]);
  const pythonVenv = join(fixtureDir, ".venv");
  const backend = opts.backend === "cursor" ? new CursorBackend() : new ClaudeBackend();

  const prevRedExtra = process.env.HELM_TDD_RED_EXTRA;
  if (opts.arm === "B") {
    process.env.HELM_TDD_RED_EXTRA = ARM_B_FRAGMENTS[opts.language];
  } else {
    delete process.env.HELM_TDD_RED_EXTRA;
  }

  try {
    for (let rep = 1; rep <= opts.reps; rep++) {
      const targetDir = await seedFixture(fixtureDir);
      const artifactRoot = mkdtempSync(join(tmpdir(), "helm-tdd-eval-artifacts-"));
      const runId = `eval-${opts.arm}-${opts.language}-${opts.feature}-r${rep}-${Date.now()}`;
      const started = Date.now();

      const spec = {
        mode: "feature",
        targetDir,
        scope: "repo",
        hitl: "auto",
        featureDescription,
        models: DEFAULT_MODELS_BY_BACKEND[opts.backend],
        maxRepairIterations: 5,
        commit: false,
        language: LANGUAGE_TO_RUNNER[opts.language],
        ...(opts.language === "py" ? { venvDir: pythonVenv } : {}),
      };

      let ledger;
      let err;
      try {
        ledger = await runFeature(spec, backend, artifactRoot, runId);
      } catch (e) {
        err = e;
      }

      const durationMs = Date.now() - started;
      const result = {
        arm: opts.arm,
        language: opts.language,
        feature: opts.feature,
        rep,
        status: ledger?.status ?? "error",
        error: err ? String(err instanceof Error ? err.message : err) : undefined,
        perSlice: ledger ? serializePerSlice(ledger.sliceResults) : [],
        totalCostUsd: ledger?.totalCostUsd ?? null,
        durationMs,
        branch: ledger?.workspace.branchName ?? null,
        workspacePath: targetDir,
      };

      const outPath = join(resultsDir, `${opts.arm}-${opts.language}-${opts.feature}-r${rep}.json`);
      writeFileSync(outPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
      console.log(`wrote ${outPath} status=${result.status}`);

      rmSync(artifactRoot, { recursive: true, force: true });
    }
  } finally {
    if (prevRedExtra === undefined) {
      delete process.env.HELM_TDD_RED_EXTRA;
    } else {
      process.env.HELM_TDD_RED_EXTRA = prevRedExtra;
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
