import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runCommand } from "../exec.js";
import { runPytest } from "../pythonRunner.js";

export interface MutationResult {
  attempted: boolean;
  mutantSurvived: boolean | null;
  constantUsed: unknown;
  reason: string;
}

const INSPECT_AND_MUTATE_SCRIPT = `
import ast, json, sys, importlib.util

impl_path, function_name, test_path = sys.argv[1], sys.argv[2], sys.argv[3]

with open(test_path) as f:
    test_source = f.read()
test_tree = ast.parse(test_source)

call_args = None
for node in ast.walk(test_tree):
    if isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id == function_name:
        if node.args and all(isinstance(a, ast.Constant) for a in node.args) and not node.keywords:
            call_args = [a.value for a in node.args]
            break

if call_args is None:
    print(json.dumps({"found": False}))
    sys.exit(0)

spec = importlib.util.spec_from_file_location("_target_module", impl_path)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
target_fn = getattr(module, function_name)
result = target_fn(*call_args)

with open(impl_path) as f:
    impl_source = f.read()
impl_tree = ast.parse(impl_source)

for node in ast.walk(impl_tree):
    if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name == function_name:
        node.body = [ast.Return(value=ast.Constant(value=result))]
        ast.fix_missing_locations(node)
        break

mutated_source = ast.unparse(impl_tree)

print(json.dumps({"found": True, "constant": result, "args": call_args, "mutatedSource": mutated_source}))
`;

interface InspectFound {
  found: true;
  constant: unknown;
  args: unknown[];
  mutatedSource: string;
}
interface InspectNotFound {
  found: false;
}

export async function checkConstantMutantGeneric(opts: {
  workDir: string;
  venvDir: string;
  implRelPath: string;
  functionName: string;
  testRelPath: string;
}): Promise<MutationResult> {
  const pythonBin = join(opts.venvDir, "bin", "python3");
  const implPath = join(opts.workDir, opts.implRelPath);
  const testPath = join(opts.workDir, opts.testRelPath);

  const inspectResult = await runCommand(
    pythonBin,
    ["-c", INSPECT_AND_MUTATE_SCRIPT, implPath, opts.functionName, testPath],
    { cwd: opts.workDir, env: { PYTHONDONTWRITEBYTECODE: "1" }, timeoutMs: 15_000 },
  );

  if (inspectResult.exitCode !== 0) {
    return {
      attempted: false,
      mutantSurvived: null,
      constantUsed: undefined,
      reason: `mutation inspection failed (exit ${inspectResult.exitCode}): ${inspectResult.stderr}`,
    };
  }

  const parsed = inspectResult.stdout
    .split("\n")
    .filter((line) => line.trim().startsWith("{"))
    .map((line) => {
      try {
        return JSON.parse(line) as InspectFound | InspectNotFound;
      } catch {
        return null;
      }
    })
    .filter((value): value is InspectFound | InspectNotFound => value !== null && typeof value.found === "boolean")
    .at(-1);

  if (!parsed) {
    return {
      attempted: false,
      mutantSurvived: null,
      constantUsed: undefined,
      reason: `mutation inspection failed: no JSON result line found in python output.\nstdout:\n${inspectResult.stdout}\nstderr:\n${inspectResult.stderr}`,
    };
  }

  if (!parsed.found) {
    return {
      attempted: false,
      mutantSurvived: null,
      constantUsed: undefined,
      reason:
        "no literal-argument call to the target function was found in the test file; cannot generate a constant mutant",
    };
  }

  const originalSource = await readFile(implPath, "utf8");

  try {
    await writeFile(implPath, parsed.mutatedSource);
    const pytestResult = await runPytest(opts.venvDir, opts.workDir, opts.testRelPath);
    const mutantSurvived = pytestResult.exitCode === 0;
    return {
      attempted: true,
      mutantSurvived,
      constantUsed: parsed.constant,
      reason: mutantSurvived
        ? "the constant mutant survived -- tests do not triangulate"
        : "the constant mutant was killed -- tests triangulate",
    };
  } finally {
    await writeFile(implPath, originalSource);
  }
}

export type MutationOperator = "constant" | "arithmetic-swap" | "comparison-swap" | "boolean-negation";

export interface OperatorMutationResult {
  operator: MutationOperator;
  applied: boolean;
  survived: boolean | null;
}

export interface MutationScoreResult {
  results: OperatorMutationResult[];
  killedCount: number;
  survivedCount: number;
  attemptedCount: number;
  score: number;
}

const APPLY_OPERATOR_SCRIPT = `
import ast, json, sys

impl_path, function_name, operator_type = sys.argv[1], sys.argv[2], sys.argv[3]

with open(impl_path) as f:
    source = f.read()
tree = ast.parse(source)

target_fn = None
for node in ast.walk(tree):
    if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name == function_name:
        target_fn = node
        break

if target_fn is None:
    print(json.dumps({"applicable": False}))
    sys.exit(0)

ARITH_SWAP = {ast.Add: ast.Sub, ast.Sub: ast.Add, ast.Mult: ast.FloorDiv, ast.FloorDiv: ast.Mult}
CMP_SWAP = {
    ast.Lt: ast.GtE, ast.LtE: ast.Gt, ast.Gt: ast.LtE, ast.GtE: ast.Lt,
    ast.Eq: ast.NotEq, ast.NotEq: ast.Eq,
}

mutated = False

if operator_type == "arithmetic-swap":
    for node in ast.walk(target_fn):
        if isinstance(node, ast.BinOp) and type(node.op) in ARITH_SWAP:
            node.op = ARITH_SWAP[type(node.op)]()
            mutated = True
            break
elif operator_type == "comparison-swap":
    for node in ast.walk(target_fn):
        if isinstance(node, ast.Compare) and len(node.ops) == 1 and type(node.ops[0]) in CMP_SWAP:
            node.ops[0] = CMP_SWAP[type(node.ops[0])]()
            mutated = True
            break
elif operator_type == "boolean-negation":
    for node in ast.walk(target_fn):
        if isinstance(node, ast.Return) and node.value is not None:
            node.value = ast.UnaryOp(op=ast.Not(), operand=node.value)
            mutated = True
            break

if not mutated:
    print(json.dumps({"applicable": False}))
    sys.exit(0)

ast.fix_missing_locations(tree)
print(json.dumps({"applicable": True, "mutatedSource": ast.unparse(tree)}))
`;

async function applyOperatorMutation(opts: {
  workDir: string;
  venvDir: string;
  implRelPath: string;
  functionName: string;
  testRelPath: string;
  operator: Exclude<MutationOperator, "constant">;
}): Promise<OperatorMutationResult> {
  const pythonBin = join(opts.venvDir, "bin", "python3");
  const implPath = join(opts.workDir, opts.implRelPath);

  const applyResult = await runCommand(
    pythonBin,
    ["-c", APPLY_OPERATOR_SCRIPT, implPath, opts.functionName, opts.operator],
    { cwd: opts.workDir, timeoutMs: 15_000 },
  );

  if (applyResult.exitCode !== 0) {
    return { operator: opts.operator, applied: false, survived: null };
  }

  const parsed = JSON.parse(applyResult.stdout) as { applicable: boolean; mutatedSource?: string };
  if (!parsed.applicable || parsed.mutatedSource === undefined) {
    return { operator: opts.operator, applied: false, survived: null };
  }

  const originalSource = await readFile(implPath, "utf8");
  try {
    await writeFile(implPath, parsed.mutatedSource);
    const pytestResult = await runPytest(opts.venvDir, opts.workDir, opts.testRelPath);
    return { operator: opts.operator, applied: true, survived: pytestResult.exitCode === 0 };
  } finally {
    await writeFile(implPath, originalSource);
  }
}

export async function computeMutationScore(opts: {
  workDir: string;
  venvDir: string;
  implRelPath: string;
  functionName: string;
  testRelPath: string;
}): Promise<MutationScoreResult> {
  const constant = await checkConstantMutantGeneric(opts);
  const results: OperatorMutationResult[] = [
    { operator: "constant", applied: constant.attempted, survived: constant.mutantSurvived },
  ];

  const operators: Array<Exclude<MutationOperator, "constant">> = [
    "arithmetic-swap",
    "comparison-swap",
    "boolean-negation",
  ];
  for (const operator of operators) {
    const result = await applyOperatorMutation({ ...opts, operator });
    results.push(result);
  }

  const attempted = results.filter((r) => r.applied);
  const killed = attempted.filter((r) => r.survived === false);
  const survived = attempted.filter((r) => r.survived === true);

  return {
    results,
    killedCount: killed.length,
    survivedCount: survived.length,
    attemptedCount: attempted.length,
    score: attempted.length === 0 ? 1 : killed.length / attempted.length,
  };
}
