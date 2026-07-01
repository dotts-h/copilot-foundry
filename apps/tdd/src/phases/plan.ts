import type { Backend } from "../backend/types.js";
import type { RepoMap } from "./map.js";
import type { ScopeReport } from "./scope.js";

export interface PlannedSlice {
  description: string;
  implRelPath: string;
  testRelPath: string;
  functionName: string;
}

export interface PlanSlicesOptions {
  backend: Backend;
  model: string;
  targetDir: string;
  featureDescription: string;
  repoMap: RepoMap;
  scopeReport: ScopeReport;
}

function buildPlanPrompt(opts: PlanSlicesOptions): string {
  return [
    "You are the planning phase of a TDD workflow. Decompose the feature below into an ORDERED list of",
    "small, independently-testable vertical slices. Each slice implements one behavior in one function.",
    "",
    `Feature: ${opts.featureDescription}`,
    `In-scope files: ${opts.scopeReport.inScope.join(", ") || "(none yet -- new files may be needed)"}`,
    "",
    "Respond with ONLY a JSON array, no prose, no markdown fences. Each element must be exactly:",
    '{"description": string, "implRelPath": string, "testRelPath": string, "functionName": string}',
    "implRelPath and testRelPath are relative paths inside the target Python repo. functionName is the",
    'exact name of the single Python function this slice implements or modifies (a valid Python',
    'identifier, e.g. "add" or "reverse_words") -- used downstream for mutation testing.',
  ].join("\n");
}

function extractJsonArray(text: string): string {
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start === -1 || end === -1 || end < start) {
    throw new Error(`planSlices: could not find a JSON array in the model's response:\n${text}`);
  }
  return text.slice(start, end + 1);
}

function isPlannedSlice(value: unknown): value is PlannedSlice {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.description === "string" &&
    typeof record.implRelPath === "string" &&
    typeof record.testRelPath === "string" &&
    typeof record.functionName === "string"
  );
}

export async function planSlices(opts: PlanSlicesOptions): Promise<PlannedSlice[]> {
  const result = await opts.backend.runPhase({
    cwd: opts.targetDir,
    model: opts.model,
    prompt: buildPlanPrompt(opts),
  });

  const jsonText = extractJsonArray(result.resultText);
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch (err) {
    throw new Error(`planSlices: model response was not valid JSON: ${String(err)}\nRaw: ${jsonText}`);
  }

  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error(`planSlices: expected a non-empty JSON array of slices, got: ${jsonText}`);
  }

  const slices = parsed.filter(isPlannedSlice);
  if (slices.length !== parsed.length) {
    throw new Error(`planSlices: some planned slices were missing required fields: ${jsonText}`);
  }

  return slices;
}
