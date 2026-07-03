import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Backend, PhaseTelemetry } from "../backend/types.js";
import { runCommand } from "../exec.js";
import type { TargetRunner } from "../runner/types.js";
import { checkDiffGuard, revertPaths } from "./diffGuard.js";

export interface RefactorMetrics {
  totalLines: number;
  maxFunctionLines: number;
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
}

function ratchetHolds(before: RefactorMetrics, after: RefactorMetrics): boolean {
  return after.totalLines <= before.totalLines && after.maxFunctionLines <= before.maxFunctionLines;
}

export async function attemptRefactor(opts: RefactorAttemptOptions): Promise<RefactorAttemptResult> {
  const implPath = join(opts.targetDir, opts.implRelPath);
  const originalSource = await readFile(implPath, "utf8");

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
  };
}
