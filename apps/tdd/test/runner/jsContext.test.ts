import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { detectJsContext } from "../../src/runner/jsContext.js";

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function initGit(root: string): void {
  mkdirSync(join(root, ".git"), { recursive: true });
}

describe("detectJsContext", () => {
  let dir: string;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("detects vitest in a plain npm package", async () => {
    dir = mkdtempSync(join(tmpdir(), "js-context-"));
    initGit(dir);
    writeJson(join(dir, "package.json"), { devDependencies: { vitest: "^1.0.0" } });
    writeFileSync(join(dir, "package-lock.json"), "");
    const ctx = await detectJsContext(dir);
    expect(ctx.framework).toBe("vitest");
    expect(ctx.packageDir).toBe(dir);
    expect(ctx.workspaceRoot).toBe(dir);
    expect(ctx.gitRoot).toBe(dir);
    expect(ctx.workspaceRelPath).toBe("");
    expect(ctx.packageRelPath).toBe("");
    expect(ctx.packageManager).toBe("npm");
  });

  it("detects jest when vitest is absent", async () => {
    dir = mkdtempSync(join(tmpdir(), "js-context-"));
    initGit(dir);
    writeJson(join(dir, "package.json"), { devDependencies: { jest: "^29.0.0" } });
    const ctx = await detectJsContext(dir);
    expect(ctx.framework).toBe("jest");
  });

  it("prefers vitest when both are declared", async () => {
    dir = mkdtempSync(join(tmpdir(), "js-context-"));
    initGit(dir);
    writeJson(join(dir, "package.json"), {
      devDependencies: { vitest: "^1.0.0", jest: "^29.0.0" },
    });
    const ctx = await detectJsContext(dir);
    expect(ctx.framework).toBe("vitest");
  });

  it("detects framework from workspace root package.json in a monorepo", async () => {
    dir = mkdtempSync(join(tmpdir(), "js-context-"));
    initGit(dir);
    const pkgDir = join(dir, "packages", "core");
    mkdirSync(pkgDir, { recursive: true });
    writeJson(join(dir, "package.json"), { devDependencies: { vitest: "^1.0.0" } });
    writeJson(join(pkgDir, "package.json"), { name: "core" });
    writeFileSync(join(dir, "pnpm-lock.yaml"), "");
    const ctx = await detectJsContext(pkgDir);
    expect(ctx.framework).toBe("vitest");
    expect(ctx.packageDir).toBe(pkgDir);
    expect(ctx.workspaceRoot).toBe(dir);
    expect(ctx.gitRoot).toBe(dir);
    expect(ctx.workspaceRelPath).toBe("");
    expect(ctx.packageRelPath).toBe("packages/core");
    expect(ctx.packageManager).toBe("pnpm");
  });

  it("detects package managers from lockfiles", async () => {
    const cases = [
      { lock: "pnpm-lock.yaml", pm: "pnpm" },
      { lock: "yarn.lock", pm: "yarn" },
      { lock: "bun.lock", pm: "bun" },
      { lock: "bun.lockb", pm: "bun" },
      { lock: "package-lock.json", pm: "npm" },
    ] as const;

    for (const { lock, pm } of cases) {
      const caseDir = mkdtempSync(join(tmpdir(), "js-context-"));
      initGit(caseDir);
      writeJson(join(caseDir, "package.json"), { devDependencies: { vitest: "^1.0.0" } });
      writeFileSync(join(caseDir, lock), "");
      const ctx = await detectJsContext(caseDir);
      expect(ctx.packageManager).toBe(pm);
      rmSync(caseDir, { recursive: true, force: true });
    }
  });

  it("throws when no vitest or jest is found", async () => {
    dir = mkdtempSync(join(tmpdir(), "js-context-"));
    initGit(dir);
    writeJson(join(dir, "package.json"), { name: "empty" });
    await expect(detectJsContext(dir)).rejects.toThrow(/no vitest or jest found/);
  });

  it("finds tsconfig.json at or above targetDir within workspaceRoot", async () => {
    dir = mkdtempSync(join(tmpdir(), "js-context-"));
    initGit(dir);
    const srcDir = join(dir, "src");
    mkdirSync(srcDir, { recursive: true });
    writeJson(join(dir, "package.json"), { devDependencies: { vitest: "^1.0.0" } });
    writeJson(join(dir, "tsconfig.json"), { compilerOptions: { strict: true } });
    const ctx = await detectJsContext(srcDir);
    expect(ctx.tsconfigPath).toBe(join(dir, "tsconfig.json"));
  });

  it("detects package and workspace in a git-root subdir (web/)", async () => {
    dir = mkdtempSync(join(tmpdir(), "js-context-"));
    initGit(dir);
    const webDir = join(dir, "web");
    mkdirSync(webDir, { recursive: true });
    writeJson(join(webDir, "package.json"), { devDependencies: { vitest: "^1.0.0" } });
    writeFileSync(join(webDir, "package-lock.json"), "");
    const ctx = await detectJsContext(webDir);
    expect(ctx.gitRoot).toBe(dir);
    expect(ctx.workspaceRoot).toBe(webDir);
    expect(ctx.packageDir).toBe(webDir);
    expect(ctx.workspaceRelPath).toBe("web");
    expect(ctx.packageRelPath).toBe("web");
  });

  it("does not walk above git root for lockfiles", async () => {
    dir = mkdtempSync(join(tmpdir(), "js-context-"));
    initGit(dir);
    const webDir = join(dir, "web");
    mkdirSync(webDir, { recursive: true });
    writeJson(join(webDir, "package.json"), { devDependencies: { vitest: "^1.0.0" } });
    writeFileSync(join(dirname(dir), "package-lock.json"), "");
    const ctx = await detectJsContext(webDir);
    expect(ctx.workspaceRoot).toBe(webDir);
    expect(ctx.packageManager).toBe("npm");
    rmSync(join(dirname(dir), "package-lock.json"), { force: true });
  });

  it("throws when no git repository is found", async () => {
    dir = mkdtempSync(join(tmpdir(), "js-context-"));
    writeJson(join(dir, "package.json"), { devDependencies: { vitest: "^1.0.0" } });
    await expect(detectJsContext(dir)).rejects.toThrow(/no git repository found/);
  });
});
