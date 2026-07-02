import { access } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { gitRootOf } from "../runWorkspace.js";
import { createGoRunner } from "./goRunner.js";
import { createJsRunner } from "./jsRunner.js";
import { createPythonRunner } from "./pythonRunner.js";
import type { TargetLanguage, TargetRunner } from "./types.js";

const PYTHON_MARKERS = [
  "pyproject.toml",
  "setup.py",
  "setup.cfg",
  "requirements.txt",
  "pytest.ini",
  "tox.ini",
] as const;

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export async function detectLanguage(targetDir: string): Promise<TargetLanguage> {
  const dir = resolve(targetDir);

  if (await pathExists(join(dir, "go.mod"))) {
    return "go";
  }

  for (const marker of PYTHON_MARKERS) {
    if (await pathExists(join(dir, marker))) {
      return "python";
    }
  }

  const gitRoot = await gitRootOf(dir);
  let scan = dir;
  while (true) {
    if (await pathExists(join(scan, "package.json"))) {
      return "js";
    }
    if (scan === gitRoot) break;
    const parent = dirname(scan);
    if (parent === scan) break;
    scan = parent;
  }

  throw new Error(
    `detectLanguage: no supported language markers found at ${dir}. ` +
      `Looked for: go.mod; ${PYTHON_MARKERS.join(", ")}; package.json (up to git root ${gitRoot})`,
  );
}

export interface ResolveRunnerOptions {
  targetDir: string;
  venvDir?: string;
  language?: TargetLanguage;
}

export async function resolveRunner(opts: ResolveRunnerOptions): Promise<TargetRunner> {
  const language = opts.language ?? (await detectLanguage(opts.targetDir));

  switch (language) {
    case "python": {
      if (!opts.venvDir) {
        throw new Error("python target requires venvDir");
      }
      return createPythonRunner(opts.venvDir);
    }
    case "js":
      return await createJsRunner(opts.targetDir);
    case "go":
      return createGoRunner(opts.targetDir);
  }
}
