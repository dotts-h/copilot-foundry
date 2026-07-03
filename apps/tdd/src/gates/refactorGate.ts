import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Backend, PhaseTelemetry } from "../backend/types.js";
import { runCommand } from "../exec.js";
import type { FunctionSpan, TargetRunner } from "../runner/types.js";
import { checkDiffGuard, revertPaths } from "./diffGuard.js";

export interface RefactorMetrics {
  totalLines: number;
  maxFunctionLines: number;
}

export interface RefactorScopeViolation {
  offendingHunks: string[];
}

const MEASURE_SCRIPT = `
import ast, json, sys
path = sys.argv[1]
with open(path) as f:
    source = f.read()
lines = [l for l in source.splitlines() if l.strip()]
total_lines = len(lines)
tree = ast.parse(source)
max_fn_lines = 0
for node in ast.walk(tree):
    if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
        span = (node.end_lineno or node.lineno) - node.lineno + 1
        max_fn_lines = max(max_fn_lines, span)
print(json.dumps({"totalLines": total_lines, "maxFunctionLines": max_fn_lines}))
`;

const HUNK_HEADER_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

export async function measurePythonFile(venvDir: string, filePath: string): Promise<RefactorMetrics> {
  const pythonBin = join(venvDir, "bin", "python3");
  const result = await runCommand(pythonBin, ["-c", MEASURE_SCRIPT, filePath], { timeoutMs: 15_000 });
  if (result.exitCode !== 0) {
    throw new Error(`measurePythonFile: failed to measure ${filePath} (exit ${result.exitCode}): ${result.stderr}`);
  }
  return JSON.parse(result.stdout) as RefactorMetrics;
}

export interface RefactorAttemptOptions {
  backend: Backend;
  targetDir: string;
  runner: TargetRunner;
  venvDir?: string;
  implRelPath: string;
  testRelPath: string;
  functionName: string;
  refactorModel: string;
  buildPrompt: () => string;
}

export interface RefactorAttemptResult {
  attempted: boolean;
  applied: boolean;
  before: RefactorMetrics | null;
  after: RefactorMetrics | null;
  reason: string;
  telemetry: PhaseTelemetry | null;
  rawTestOutput: string | null;
  scopeViolation: RefactorScopeViolation | null;
  scopeCheck: "enforced" | "skipped_no_spans";
  scopeAllowed: FunctionSpan[] | null;
}

function ratchetHolds(before: RefactorMetrics, after: RefactorMetrics): boolean {
  return after.totalLines <= before.totalLines && after.maxFunctionLines <= before.maxFunctionLines;
}

function escapeRegex(name: string): string {
  return name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function lineInSpan(line: number, span: FunctionSpan): boolean {
  return line >= span.startLine && line <= span.endLine;
}

function lineInAllowed(line: number, allowed: FunctionSpan[]): boolean {
  return allowed.some((span) => lineInSpan(line, span));
}

function spanSourceText(span: FunctionSpan, sourceLines: string[]): string {
  return sourceLines.slice(span.startLine - 1, span.endLine).join("\n");
}

function computeAllowedSpans(
  preSpans: FunctionSpan[],
  postSpans: FunctionSpan[],
  functionName: string,
  sourceLines: string[],
): FunctionSpan[] | null {
  if (preSpans.length === 0 || postSpans.length === 0) {
    return null;
  }

  const sliceSpan = postSpans.find((span) => span.name === functionName);
  if (!sliceSpan) {
    return null;
  }

  const preNames = new Set(preSpans.map((span) => span.name));
  const newFns = postSpans.filter((span) => !preNames.has(span.name));

  const allowed: FunctionSpan[] = [sliceSpan];
  const allowedNames = new Set([sliceSpan.name]);

  let changed = true;
  while (changed) {
    changed = false;
    for (const fn of newFns) {
      if (allowedNames.has(fn.name)) {
        continue;
      }
      const wordRe = new RegExp(`\\b${escapeRegex(fn.name)}\\b`);
      for (const span of allowed) {
        if (wordRe.test(spanSourceText(span, sourceLines))) {
          allowed.push(fn);
          allowedNames.add(fn.name);
          changed = true;
          break;
        }
      }
    }
  }

  return allowed;
}

function parseHunkHeaders(diff: string): Array<{ header: string; c: number; d: number }> {
  const hunks: Array<{ header: string; c: number; d: number }> = [];
  for (const line of diff.split("\n")) {
    const match = line.match(HUNK_HEADER_RE);
    if (!match) {
      continue;
    }
    const c = Number.parseInt(match[3], 10);
    const d = match[4] !== undefined ? Number.parseInt(match[4], 10) : 1;
    hunks.push({ header: line.trim(), c, d });
  }
  return hunks;
}

function isBlankLine(content: string): boolean {
  return content.trim().length === 0;
}

function hunkInBounds(c: number, d: number, allowed: FunctionSpan[], sourceLines: string[]): boolean {
  if (d === 0) {
    return lineInAllowed(c, allowed) && lineInAllowed(c + 1, allowed);
  }
  const end = c + Math.max(d, 1) - 1;
  for (let line = c; line <= end; line++) {
    const content = sourceLines[line - 1] ?? "";
    if (!lineInAllowed(line, allowed) && !isBlankLine(content)) {
      return false;
    }
  }
  return true;
}

async function checkRefactorScope(opts: {
  targetDir: string;
  implRelPath: string;
  functionName: string;
  preSpans: FunctionSpan[];
  postSpans: FunctionSpan[];
  sourceLines: string[];
}): Promise<
  | { scopeCheck: "skipped_no_spans"; scopeViolation: null; scopeAllowed: null }
  | { scopeCheck: "enforced"; scopeViolation: RefactorScopeViolation | null; scopeAllowed: FunctionSpan[] }
> {
  const allowed = computeAllowedSpans(opts.preSpans, opts.postSpans, opts.functionName, opts.sourceLines);
  if (!allowed) {
    return { scopeCheck: "skipped_no_spans", scopeViolation: null, scopeAllowed: null };
  }

  const diffResult = await runCommand("git", ["diff", "-U0", "HEAD", "--", opts.implRelPath], {
    cwd: opts.targetDir,
    timeoutMs: 15_000,
  });
  const hunks = parseHunkHeaders(diffResult.stdout);
  const offendingHunks = hunks
    .filter((hunk) => !hunkInBounds(hunk.c, hunk.d, allowed, opts.sourceLines))
    .map((hunk) => hunk.header);

  return {
    scopeCheck: "enforced",
    scopeViolation: offendingHunks.length > 0 ? { offendingHunks } : null,
    scopeAllowed: allowed,
  };
}

export async function attemptRefactor(opts: RefactorAttemptOptions): Promise<RefactorAttemptResult> {
  const implPath = join(opts.targetDir, opts.implRelPath);
  const originalSource = await readFile(implPath, "utf8");
  const preSpans = await opts.runner.functionSpans(implPath);

  let before: RefactorMetrics | null = null;
  if (opts.runner.language === "python") {
    if (!opts.venvDir) {
      throw new Error("attemptRefactor: python refactor requires venvDir");
    }
    before = await measurePythonFile(opts.venvDir, implPath);
  }

  const phase = await opts.backend.runPhase({
    cwd: opts.targetDir,
    model: opts.refactorModel,
    prompt: opts.buildPrompt(),
    lockedPaths: [opts.testRelPath],
  });

  const guard = await checkDiffGuard(opts.targetDir, [opts.testRelPath]);
  if (guard.violated) {
    await revertPaths(opts.targetDir, guard.offendingPaths);
  }

  const testResult = await opts.runner.runTests(opts.targetDir, opts.testRelPath);
  if (opts.runner.classifyRun(testResult) !== "passed") {
    await writeFile(implPath, originalSource);
    return {
      attempted: true,
      applied: false,
      before,
      after: null,
      reason: "refactor broke the test; reverted",
      telemetry: phase.telemetry,
      rawTestOutput: testResult.raw,
      scopeViolation: null,
      scopeCheck: "skipped_no_spans",
      scopeAllowed: null,
    };
  }

  const postSource = await readFile(implPath, "utf8");
  const postSpans = await opts.runner.functionSpans(implPath);
  const scopeResult = await checkRefactorScope({
    targetDir: opts.targetDir,
    implRelPath: opts.implRelPath,
    functionName: opts.functionName,
    preSpans,
    postSpans,
    sourceLines: postSource.split("\n"),
  });

  if (scopeResult.scopeViolation) {
    await writeFile(implPath, originalSource);
    return {
      attempted: true,
      applied: false,
      before,
      after: null,
      reason: "refactor exceeded slice scope; reverted",
      telemetry: phase.telemetry,
      rawTestOutput: testResult.raw,
      scopeViolation: scopeResult.scopeViolation,
      scopeCheck: scopeResult.scopeCheck,
      scopeAllowed: scopeResult.scopeAllowed,
    };
  }

  if (opts.runner.language !== "python") {
    return {
      attempted: true,
      applied: true,
      before: null,
      after: null,
      reason: "refactor applied; tests pass",
      telemetry: phase.telemetry,
      rawTestOutput: testResult.raw,
      scopeViolation: null,
      scopeCheck: scopeResult.scopeCheck,
      scopeAllowed: scopeResult.scopeAllowed,
    };
  }

  const after = await measurePythonFile(opts.venvDir!, implPath);
  if (!ratchetHolds(before!, after)) {
    await writeFile(implPath, originalSource);
    return {
      attempted: true,
      applied: false,
      before,
      after,
      reason: "ratchet violated (metrics worsened); reverted",
      telemetry: phase.telemetry,
      rawTestOutput: testResult.raw,
      scopeViolation: null,
      scopeCheck: scopeResult.scopeCheck,
      scopeAllowed: scopeResult.scopeAllowed,
    };
  }

  return {
    attempted: true,
    applied: true,
    before,
    after,
    reason: "refactor applied; ratchet holds",
    telemetry: phase.telemetry,
    rawTestOutput: testResult.raw,
    scopeViolation: null,
    scopeCheck: scopeResult.scopeCheck,
    scopeAllowed: scopeResult.scopeAllowed,
  };
}
