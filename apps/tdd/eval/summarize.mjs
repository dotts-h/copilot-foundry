#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

function mean(values) {
  if (values.length === 0) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function loadRuns(resultsDir) {
  const files = readdirSync(resultsDir).filter((f) => f.endsWith(".json"));
  return files.map((f) => JSON.parse(readFileSync(join(resultsDir, f), "utf8")));
}

function groupKey(run) {
  return `${run.arm}\t${run.language}\t${run.feature}`;
}

function summarizeGroup(runs) {
  const accepted = runs.filter((r) => r.status === "accepted").length;
  const mutationScores = [];
  const greenIterations = [];
  let redLintBlocking = 0;
  const costs = [];
  const branches = [];

  for (const run of runs) {
    if (run.branch) branches.push(run.branch);
    if (typeof run.totalCostUsd === "number") costs.push(run.totalCostUsd);

    let runHadRedLintBlock = false;
    for (const slice of run.perSlice ?? []) {
      if (typeof slice.mutationScore === "number") mutationScores.push(slice.mutationScore);
      if (typeof slice.greenIterationsUsed === "number") greenIterations.push(slice.greenIterationsUsed);
      if (slice.redLint?.blocking?.length > 0) runHadRedLintBlock = true;
    }
    if (runHadRedLintBlock) redLintBlocking += 1;
  }

  return {
    runCount: runs.length,
    acceptedRate: runs.length > 0 ? accepted / runs.length : 0,
    meanMutationScore: mean(mutationScores),
    meanGreenIterations: mean(greenIterations),
    redLintBlockingCount: redLintBlocking,
    meanCostUsd: costs.length > 0 ? mean(costs) : null,
    branches,
  };
}

function formatTable(rows) {
  const headers = [
    "arm",
    "lang",
    "feature",
    "runs",
    "accepted%",
    "mutScore",
    "greenIter",
    "redLintBlk",
    "cost",
    "branches",
  ];
  const lines = [headers.join("\t")];
  for (const row of rows) {
    lines.push(
      [
        row.arm,
        row.language,
        row.feature,
        String(row.runCount),
        row.acceptedRate === null ? "-" : `${(row.acceptedRate * 100).toFixed(0)}%`,
        row.meanMutationScore === null ? "-" : row.meanMutationScore.toFixed(2),
        row.meanGreenIterations === null ? "-" : row.meanGreenIterations.toFixed(2),
        String(row.redLintBlockingCount),
        row.meanCostUsd === null ? "-" : row.meanCostUsd.toFixed(4),
        row.branches.join(", "),
      ].join("\t"),
    );
  }
  return lines.join("\n");
}

function main() {
  const resultsDir = resolve(process.argv[2] ?? "");
  if (!resultsDir || !existsSync(resultsDir)) {
    console.error("Usage: node eval/summarize.mjs <resultsDir>");
    process.exit(1);
  }

  const runs = loadRuns(resultsDir);
  const groups = new Map();
  for (const run of runs) {
    const key = groupKey(run);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(run);
  }

  const rows = [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, groupRuns]) => {
      const [arm, language, feature] = key.split("\t");
      return { arm, language, feature, ...summarizeGroup(groupRuns) };
    });

  console.log(formatTable(rows));
}

main();
