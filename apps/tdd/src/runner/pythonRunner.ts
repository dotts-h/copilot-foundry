import { randomBytes } from "node:crypto";
import { readdir, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCommand } from "../exec.js";
import { computeMutationScore as computeMutationScoreImpl } from "../gates/mutationGate.js";
import { parsePytestVerboseOutput } from "../phases/baseline.js";
import type { FileSymbols } from "../phases/map.js";
import type { RunClassification, TargetRunner, TestRunResult } from "./types.js";

const NO_TESTS_COLLECTED = 5;

const PYTHON_SYMBOL_EXTRACTOR = String.raw`import ast
import json
import re
import sys

UPPER_SNAKE = re.compile(r"^[A-Z][A-Z0-9_]*$")


def render_arg(arg, default=None):
    parts = [arg.arg]
    if arg.annotation is not None:
        parts.append(f": {ast.unparse(arg.annotation)}")
    if default is not None:
        parts.append(f" = {ast.unparse(default)}")
    return "".join(parts)


def render_signature(node):
    args = node.args
    params = []
    posonly = args.posonlyargs
    regular = args.args
    all_pos = posonly + regular
    num_pos = len(all_pos)
    num_defaults = len(args.defaults)
    default_start = num_pos - num_defaults

    for i, arg in enumerate(all_pos):
        default = args.defaults[i - default_start] if i >= default_start else None
        params.append(render_arg(arg, default))

    if posonly:
        params.append("/")

    if args.vararg is not None:
        if args.vararg.annotation is not None:
            params.append(f"*{args.vararg.arg}: {ast.unparse(args.vararg.annotation)}")
        else:
            params.append(f"*{args.vararg.arg}")
    elif args.kwonlyargs:
        params.append("*")

    for i, arg in enumerate(args.kwonlyargs):
        params.append(render_arg(arg, args.kw_defaults[i]))

    if args.kwarg is not None:
        if args.kwarg.annotation is not None:
            params.append(f"**{args.kwarg.arg}: {ast.unparse(args.kwarg.annotation)}")
        else:
            params.append(f"**{args.kwarg.arg}")

    prefix = "async " if isinstance(node, ast.AsyncFunctionDef) else ""
    ret = f" -> {ast.unparse(node.returns)}" if node.returns is not None else ""
    return f"{prefix}{node.name}({', '.join(params)}){ret}"


def function_symbol(node):
    return {
        "name": node.name,
        "signature": render_signature(node),
        "line": node.lineno,
    }


def class_methods(class_node):
    methods = []
    for item in class_node.body:
        if isinstance(item, (ast.FunctionDef, ast.AsyncFunctionDef)):
            methods.append(function_symbol(item))
    return methods


def is_upper_snake_name(name):
    return UPPER_SNAKE.match(name) is not None


def extract_constants(tree):
    constants = []
    for node in tree.body:
        if isinstance(node, ast.Assign):
            if len(node.targets) == 1 and isinstance(node.targets[0], ast.Name):
                name = node.targets[0].id
                if is_upper_snake_name(name):
                    constants.append(name)
        elif isinstance(node, ast.AnnAssign):
            if isinstance(node.target, ast.Name):
                name = node.target.id
                if is_upper_snake_name(name):
                    constants.append(name)
    return constants


def extract_file_symbols(source):
    try:
        tree = ast.parse(source)
    except SyntaxError:
        return {
            "functions": [],
            "classes": [],
            "constants": [],
            "error": "unparsed",
        }

    functions = []
    classes = []
    for node in tree.body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            functions.append(function_symbol(node))
        elif isinstance(node, ast.ClassDef):
            classes.append({
                "name": node.name,
                "line": node.lineno,
                "methods": class_methods(node),
            })

    constants = extract_constants(tree)
    result = {
        "functions": functions,
        "classes": classes,
        "constants": constants,
    }
    if not functions and not classes and not constants:
        return None
    return result


def main():
    root = sys.argv[1]
    rel_paths = sys.argv[2:]
    output = {}
    for rel_path in rel_paths:
        try:
            with open(f"{root}/{rel_path}", encoding="utf-8") as fh:
                source = fh.read()
        except (OSError, UnicodeDecodeError):
            output[rel_path] = {
                "functions": [],
                "classes": [],
                "constants": [],
                "error": "unparsed",
            }
            continue
        symbols = extract_file_symbols(source)
        if symbols is not None:
            output[rel_path] = symbols
    json.dump(output, sys.stdout)


if __name__ == "__main__":
    main()
`;

export const PYTHON_RED_PROMPT_RULES =
  "If the function or symbol under test does not exist yet in the implementation module, do NOT add it " +
  "to a module-top import -- import it inside the new test function(s) instead, so the rest of the test " +
  "module still collects and runs. Never modify or remove existing imports. ";

export const PYTHON_MISSING_SYMBOL_RED_NOTE =
  " — remember the import-inside-the-test-function rule above.";

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function isMissingSymbolError(raw: string, functionName: string): boolean {
  const name = escapeRegExp(functionName);
  const patterns = [
    new RegExp(`cannot import name '${name}'`),
    new RegExp(`has no attribute '${name}'`),
    new RegExp(`NameError: name '${name}'`),
  ];
  return patterns.some((pattern) => pattern.test(raw));
}

export function createPythonRunner(venvDir: string): TargetRunner {
  async function runTests(workDir: string, targetRelPath?: string): Promise<TestRunResult> {
    const pytestBin = join(venvDir, "bin", "pytest");
    const result = await runCommand(pytestBin, ["-q", "-o", "addopts=", targetRelPath ?? "."], {
      cwd: workDir,
      env: { PYTHONDONTWRITEBYTECODE: "1" },
      timeoutMs: 60_000,
    });
    return {
      exitCode: result.exitCode,
      raw: result.stdout + result.stderr,
    };
  }

  async function runTestsOnPaths(workDir: string, paths: string[]): Promise<TestRunResult> {
    const pytestBin = join(venvDir, "bin", "pytest");
    const args = ["-q", "-o", "addopts=", ...(paths.length > 0 ? paths : ["."])];
    const result = await runCommand(pytestBin, args, {
      cwd: workDir,
      env: { PYTHONDONTWRITEBYTECODE: "1" },
      timeoutMs: 60_000,
    });
    return { exitCode: result.exitCode, raw: result.stdout + result.stderr };
  }

  async function runTestsVerbose(workDir: string): Promise<{ exitCode: number; tests: import("../phases/baseline.js").BaselineTestResult[] }> {
    const pytestBin = join(venvDir, "bin", "pytest");
    const result = await runCommand(pytestBin, ["-o", "addopts=", "--tb=no", "-v"], {
      cwd: workDir,
      env: { PYTHONDONTWRITEBYTECODE: "1" },
      timeoutMs: 60_000,
    });

    if (result.exitCode === NO_TESTS_COLLECTED) {
      return { exitCode: result.exitCode, tests: [] };
    }

    return { exitCode: result.exitCode, tests: parsePytestVerboseOutput(result.stdout) };
  }

  async function extractSymbols(targetDir: string, files: string[]): Promise<Record<string, FileSymbols>> {
    if (files.length === 0) return {};

    const scriptPath = join(tmpdir(), `tdd-map-extract-${randomBytes(8).toString("hex")}.py`);
    try {
      await writeFile(scriptPath, PYTHON_SYMBOL_EXTRACTOR, "utf8");
      const python = join(venvDir, "bin", "python");
      const result = await runCommand(python, [scriptPath, targetDir, ...files], {
        timeoutMs: 30_000,
      });
      if (result.exitCode !== 0) return {};
      try {
        const parsed: unknown = JSON.parse(result.stdout.trim());
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
        return parsed as Record<string, FileSymbols>;
      } catch {
        return {};
      }
    } catch {
      return {};
    } finally {
      await unlink(scriptPath).catch(() => {});
    }
  }

  function isTestFile(relPath: string): boolean {
    const base = relPath.split("/").pop() ?? relPath;
    return base.startsWith("test_") || base.endsWith("_test.py");
  }

  return {
    language: "python",
    testFrameworkName: "pytest",
    redPromptRules: PYTHON_RED_PROMPT_RULES,
    missingSymbolRedNote: PYTHON_MISSING_SYMBOL_RED_NOTE,

    async ensureEnv(_workDir: string): Promise<void> {},

    runTests,
    runTestsOnPaths,
    runTestsVerbose,

    classifyRun(result: TestRunResult): RunClassification {
      if (result.exitCode === 0) return "passed";
      if (result.exitCode === 1) return "failed";
      return "harness_error";
    },

    isMissingSymbolError,

    testPathKey(relPath: string): string {
      return relPath;
    },

    isSourceFile(relPath: string): boolean {
      return relPath.endsWith(".py");
    },

    isTestFile,

    extractSymbols,

    computeMutationScore(opts) {
      return computeMutationScoreImpl({ ...opts, venvDir });
    },

    async runStaticGates(_workDir: string) {
      return [];
    },
  };
}
