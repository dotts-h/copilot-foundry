import { access, readFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";

export interface JsContext {
  framework: "vitest" | "jest";
  packageDir: string;
  workspaceRoot: string;
  gitRoot: string;
  workspaceRelPath: string;
  packageRelPath: string;
  packageManager: "pnpm" | "npm" | "yarn" | "bun";
  testBin: string | null;
  tscBin: string | null;
  tsconfigPath: string | null;
}

interface PackageJson {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function readPackageJson(dir: string): Promise<PackageJson | null> {
  const path = join(dir, "package.json");
  if (!(await pathExists(path))) return null;
  try {
    return JSON.parse(await readFile(path, "utf8")) as PackageJson;
  } catch {
    return null;
  }
}

function hasDependency(pkg: PackageJson | null, name: string): boolean {
  if (!pkg) return false;
  return Boolean(pkg.dependencies?.[name] ?? pkg.devDependencies?.[name]);
}

async function findPackageDir(targetDir: string): Promise<string> {
  let dir = resolve(targetDir);
  while (true) {
    if (await pathExists(join(dir, "package.json"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`no package.json found at or above ${targetDir}`);
}

async function findGitRoot(startDir: string): Promise<string> {
  let dir = resolve(startDir);
  while (true) {
    if (await pathExists(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`no git repository found at or above ${startDir}`);
}

async function findWorkspaceRoot(
  packageDir: string,
  gitRoot: string,
): Promise<{ workspaceRoot: string; packageManager: JsContext["packageManager"] }> {
  let dir = resolve(packageDir);
  const stop = resolve(gitRoot);
  while (true) {
    if (await pathExists(join(dir, "pnpm-lock.yaml"))) {
      return { workspaceRoot: dir, packageManager: "pnpm" };
    }
    if ((await pathExists(join(dir, "bun.lockb"))) || (await pathExists(join(dir, "bun.lock")))) {
      return { workspaceRoot: dir, packageManager: "bun" };
    }
    if (await pathExists(join(dir, "yarn.lock"))) {
      return { workspaceRoot: dir, packageManager: "yarn" };
    }
    if (await pathExists(join(dir, "package-lock.json"))) {
      return { workspaceRoot: dir, packageManager: "npm" };
    }
    if (dir === stop) break;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return { workspaceRoot: packageDir, packageManager: "npm" };
}

async function detectFramework(packageDir: string, workspaceRoot: string): Promise<"vitest" | "jest"> {
  const pkgJson = await readPackageJson(packageDir);
  const rootJson = packageDir === workspaceRoot ? null : await readPackageJson(workspaceRoot);

  if (hasDependency(pkgJson, "vitest") || hasDependency(rootJson, "vitest")) {
    return "vitest";
  }
  if (hasDependency(pkgJson, "jest") || hasDependency(rootJson, "jest")) {
    return "jest";
  }
  throw new Error(`no vitest or jest found for ${packageDir}`);
}

export async function resolveBin(startDir: string, workspaceRoot: string, binName: string): Promise<string | null> {
  let dir = resolve(startDir);
  const stop = resolve(workspaceRoot);
  while (true) {
    const binPath = join(dir, "node_modules", ".bin", binName);
    if (await pathExists(binPath)) return binPath;
    if (dir === stop) break;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

export async function findTsconfig(targetDir: string, workspaceRoot: string): Promise<string | null> {
  let dir = resolve(targetDir);
  const stop = resolve(workspaceRoot);
  while (true) {
    const tsconfigPath = join(dir, "tsconfig.json");
    if (await pathExists(tsconfigPath)) return tsconfigPath;
    if (dir === stop) break;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

export async function detectJsContext(targetDir: string): Promise<JsContext> {
  const packageDir = await findPackageDir(targetDir);
  const gitRoot = await findGitRoot(packageDir);
  const { workspaceRoot, packageManager } = await findWorkspaceRoot(packageDir, gitRoot);
  const framework = await detectFramework(packageDir, workspaceRoot);
  const testBinName = framework === "vitest" ? "vitest" : "jest";
  const testBin = await resolveBin(targetDir, workspaceRoot, testBinName);
  const tscBin = await resolveBin(targetDir, workspaceRoot, "tsc");
  const tsconfigPath = await findTsconfig(targetDir, workspaceRoot);
  const workspaceRelPath = relative(gitRoot, workspaceRoot);
  const packageRelPath = relative(gitRoot, packageDir);

  return {
    framework,
    packageDir,
    workspaceRoot,
    gitRoot,
    workspaceRelPath,
    packageRelPath,
    packageManager,
    testBin,
    tscBin,
    tsconfigPath,
  };
}
