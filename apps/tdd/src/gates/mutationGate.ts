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
    { cwd: opts.workDir, timeoutMs: 15_000 },
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
