import { randomBytes } from "node:crypto";
import { readdir, readFile, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { runCommand } from "../exec.js";

export interface SymbolFunction {
  name: string;
  signature: string;
  line: number;
}

export interface SymbolClass {
  name: string;
  line: number;
  methods: SymbolFunction[];
}

export interface FileSymbols {
  functions: SymbolFunction[];
  classes: SymbolClass[];
  constants: string[];
  error?: string;
}

export interface RepoMap {
  files: string[];
  testFiles: string[];
  imports: Record<string, string[]>;
  symbols: Record<string, FileSymbols>;
}

const SKIP_DIRS = new Set([".git", ".venv", "__pycache__", "node_modules"]);

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
        with open(f"{root}/{rel_path}", encoding="utf-8") as fh:
            source = fh.read()
        symbols = extract_file_symbols(source)
        if symbols is not None:
            output[rel_path] = symbols
    json.dump(output, sys.stdout)


if __name__ == "__main__":
    main()
`;

async function walkPythonFiles(root: string, dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      files.push(...(await walkPythonFiles(root, join(dir, entry.name))));
    } else if (entry.isFile() && entry.name.endsWith(".py")) {
      files.push(relative(root, join(dir, entry.name)));
    }
  }
  return files;
}

function isTestFile(relPath: string): boolean {
  const base = relPath.split("/").pop() ?? relPath;
  return base.startsWith("test_") || base.endsWith("_test.py");
}

function extractImports(source: string): string[] {
  const modules = new Set<string>();
  const importRegex = /^\s*(?:from\s+([\w.]+)\s+import|import\s+([\w.]+))/gm;
  let match: RegExpExecArray | null;
  while ((match = importRegex.exec(source)) !== null) {
    const module = match[1] ?? match[2];
    if (module) modules.add(module);
  }
  return [...modules];
}

async function extractSymbols(
  venvDir: string,
  targetDir: string,
  files: string[],
): Promise<Record<string, FileSymbols>> {
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

export async function mapRepo(targetDir: string, venvDir?: string): Promise<RepoMap> {
  const files = (await walkPythonFiles(targetDir, targetDir)).sort();
  const testFiles = files.filter(isTestFile);
  const imports: Record<string, string[]> = {};

  for (const relPath of files) {
    const source = await readFile(join(targetDir, relPath), "utf8");
    const found = extractImports(source);
    if (found.length > 0) imports[relPath] = found;
  }

  const symbols = venvDir ? await extractSymbols(venvDir, targetDir, files) : {};

  return { files, testFiles, imports, symbols };
}
