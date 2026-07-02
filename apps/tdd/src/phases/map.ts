import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { goModulePath } from "../goRunner.js";
import type { Language } from "../types.js";

export interface RepoMap {
  files: string[];
  testFiles: string[];
  imports: Record<string, string[]>;
  modulePath?: string;
}

const SKIP_DIRS = new Set([".git", ".venv", "__pycache__", "node_modules"]);
const GO_SKIP_DIRS = new Set([...SKIP_DIRS, "vendor", "testdata"]);

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

async function walkGoFiles(root: string, dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (GO_SKIP_DIRS.has(entry.name)) continue;
      files.push(...(await walkGoFiles(root, join(dir, entry.name))));
    } else if (entry.isFile() && entry.name.endsWith(".go")) {
      files.push(relative(root, join(dir, entry.name)));
    }
  }
  return files;
}

function isGoTestFile(relPath: string): boolean {
  return relPath.endsWith("_test.go");
}

function extractGoImports(source: string): string[] {
  const modules = new Set<string>();

  const singleImportRegex = /^\s*import\s+(?:\w+\s+)?"([^"]+)"/gm;
  let match: RegExpExecArray | null;
  while ((match = singleImportRegex.exec(source)) !== null) {
    modules.add(match[1]);
  }

  const blockImportRegex = /^\s*import\s*\(([\s\S]*?)\)/gm;
  while ((match = blockImportRegex.exec(source)) !== null) {
    const lineRegex = /^\s*(?:\w+\s+)?"([^"]+)"/gm;
    let lineMatch: RegExpExecArray | null;
    while ((lineMatch = lineRegex.exec(match[1])) !== null) {
      modules.add(lineMatch[1]);
    }
  }

  return [...modules];
}

async function mapGoRepo(targetDir: string): Promise<RepoMap> {
  const files = (await walkGoFiles(targetDir, targetDir)).sort();
  const testFiles = files.filter(isGoTestFile);
  const imports: Record<string, string[]> = {};

  for (const relPath of files) {
    const source = await readFile(join(targetDir, relPath), "utf8");
    const found = extractGoImports(source);
    if (found.length > 0) imports[relPath] = found;
  }

  const modulePath = await goModulePath(targetDir);
  return { files, testFiles, imports, modulePath };
}

export async function mapRepo(targetDir: string, language: Language): Promise<RepoMap> {
  if (language === "go") {
    return mapGoRepo(targetDir);
  }

  const files = (await walkPythonFiles(targetDir, targetDir)).sort();
  const testFiles = files.filter(isTestFile);
  const imports: Record<string, string[]> = {};

  for (const relPath of files) {
    const source = await readFile(join(targetDir, relPath), "utf8");
    const found = extractImports(source);
    if (found.length > 0) imports[relPath] = found;
  }

  return { files, testFiles, imports };
}
