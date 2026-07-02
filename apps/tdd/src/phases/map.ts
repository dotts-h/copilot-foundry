import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import type { TargetRunner } from "../runner/types.js";

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

async function walkSourceFiles(root: string, dir: string, runner?: TargetRunner): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      files.push(...(await walkSourceFiles(root, join(dir, entry.name), runner)));
    } else if (entry.isFile()) {
      const relPath = relative(root, join(dir, entry.name));
      const isSource = runner ? runner.isSourceFile(relPath) : entry.name.endsWith(".py");
      if (isSource) {
        files.push(relPath);
      }
    }
  }
  return files;
}

function defaultIsTestFile(relPath: string): boolean {
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

export async function mapRepo(targetDir: string, runner?: TargetRunner): Promise<RepoMap> {
  const files = (await walkSourceFiles(targetDir, targetDir, runner)).sort();
  const isTestFile = runner ? (relPath: string) => runner.isTestFile(relPath) : defaultIsTestFile;
  const testFiles = files.filter(isTestFile);
  const imports: Record<string, string[]> = {};

  for (const relPath of files) {
    const source = await readFile(join(targetDir, relPath), "utf8");
    const found = extractImports(source);
    if (found.length > 0) imports[relPath] = found;
  }

  const symbols = runner ? await runner.extractSymbols(targetDir, files) : {};

  return { files, testFiles, imports, symbols };
}
