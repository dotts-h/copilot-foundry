import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";

export interface RepoMap {
  files: string[];
  testFiles: string[];
  imports: Record<string, string[]>;
}

const SKIP_DIRS = new Set([".git", ".venv", "__pycache__", "node_modules"]);

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

export async function mapRepo(targetDir: string): Promise<RepoMap> {
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
