import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  classifyJsRun,
  createJsRunner,
  isMissingSymbolError,
  jsRunnerDeps,
  parseJestVerboseOutput,
  parseVitestVerboseOutput,
  toPackageRelative,
  VITEST_RED_PROMPT_RULES,
} from "../../src/runner/jsRunner.js";

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function initGit(root: string): void {
  mkdirSync(join(root, ".git"), { recursive: true });
}

describe("toPackageRelative", () => {
  it("passes through when packageRelPath is empty", () => {
    expect(toPackageRelative("", "src/foo.test.ts")).toBe("src/foo.test.ts");
  });

  it("strips package prefix for in-package paths", () => {
    expect(toPackageRelative("web", "web")).toBe(".");
    expect(toPackageRelative("web", "web/src/foo.test.ts")).toBe("src/foo.test.ts");
    expect(toPackageRelative("packages/core", "packages/core/src/foo.test.ts")).toBe("src/foo.test.ts");
  });

  it("returns absolute path for out-of-package paths when workDir is given", () => {
    expect(toPackageRelative("web", "other/foo.test.ts", "/worktree")).toBe("/worktree/other/foo.test.ts");
  });

  it("returns relPath unchanged for out-of-package paths without workDir", () => {
    expect(toPackageRelative("web", "other/foo.test.ts")).toBe("other/foo.test.ts");
  });
});

describe("parseVitestVerboseOutput", () => {
  it("parses passed, failed, and skipped lines including ANSI codes", () => {
    const raw = [
      "\u001b[32m ✓ \u001b[39m src/math.test.ts > adds numbers",
      " ✓ src/math.test.ts > suite > nested test",
      " × src/math.test.ts > fails sometimes",
      " ↓ src/math.test.ts > skipped case",
    ].join("\n");

    expect(parseVitestVerboseOutput(raw)).toEqual([
      { nodeId: "src/math.test.ts::adds numbers", outcome: "passed" },
      { nodeId: "src/math.test.ts::suite > nested test", outcome: "passed" },
      { nodeId: "src/math.test.ts::fails sometimes", outcome: "failed" },
      { nodeId: "src/math.test.ts::skipped case", outcome: "skipped" },
    ]);
  });
});

describe("parseJestVerboseOutput", () => {
  it("parses per-file headers and indented test lines", () => {
    const raw = [
      "PASS src/math.test.ts",
      "  ✓ adds numbers (3 ms)",
      "  ✕ fails sometimes (2 ms)",
      "  ○ skipped case",
      "FAIL src/other.test.ts",
      "  ✕ broken",
    ].join("\n");

    expect(parseJestVerboseOutput(raw)).toEqual([
      { nodeId: "src/math.test.ts::adds numbers", outcome: "passed" },
      { nodeId: "src/math.test.ts::fails sometimes", outcome: "failed" },
      { nodeId: "src/math.test.ts::skipped case", outcome: "skipped" },
      { nodeId: "src/other.test.ts::broken", outcome: "failed" },
    ]);
  });
});

describe("classifyJsRun", () => {
  it("maps exit codes and harness markers", () => {
    expect(classifyJsRun("vitest", { exitCode: 0, raw: "" })).toBe("passed");
    expect(classifyJsRun("vitest", { exitCode: 1, raw: "1 failed" })).toBe("failed");
    expect(classifyJsRun("vitest", { exitCode: 1, raw: "Failed to load config" })).toBe("harness_error");
    expect(classifyJsRun("jest", { exitCode: 1, raw: "Test suite failed to run" })).toBe("harness_error");
    expect(classifyJsRun("jest", { exitCode: 2, raw: "" })).toBe("harness_error");
  });
});

describe("isMissingSymbolError", () => {
  const name = "fetchUser";
  const positives = [
    `does not provide an export named '${name}'`,
    `has no exported member '${name}'`,
    `has no exported member named '${name}'`,
    `${name} is not a function`,
    `${name} is not defined`,
    `Property '${name}' does not exist`,
    `Cannot destructure property '${name}'`,
  ];

  it.each(positives)("matches %j", (raw) => {
    expect(isMissingSymbolError(raw, name)).toBe(true);
  });

  it("does not match a different symbol name", () => {
    expect(isMissingSymbolError(`Property 'otherFn' does not exist`, name)).toBe(false);
  });
});

describe("createJsRunner command construction", () => {
  let dir: string;
  let runSpy: ReturnType<typeof vi.spyOn>;

  afterEach(() => {
    runSpy.mockRestore();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  beforeEach(() => {
    runSpy = vi.spyOn(jsRunnerDeps, "runCommand").mockResolvedValue({
      exitCode: 0,
      stdout: "",
      stderr: "",
    });
  });

  function seedVitestPackage(): void {
    dir = mkdtempSync(join(tmpdir(), "js-runner-"));
    initGit(dir);
    writeJson(join(dir, "package.json"), { devDependencies: { vitest: "^1.0.0" } });
    writeFileSync(join(dir, "package-lock.json"), "");
    mkdirSync(join(dir, "node_modules", ".bin"), { recursive: true });
    writeFileSync(join(dir, "node_modules", ".bin", "vitest"), "#!/usr/bin/env node\n");
  }

  function seedJestPackage(): void {
    dir = mkdtempSync(join(tmpdir(), "js-runner-"));
    initGit(dir);
    writeJson(join(dir, "package.json"), { devDependencies: { jest: "^29.0.0" } });
    mkdirSync(join(dir, "node_modules", ".bin"), { recursive: true });
    writeFileSync(join(dir, "node_modules", ".bin", "jest"), "#!/usr/bin/env node\n");
  }

  it("builds vitest runTests argv without basic reporter and with CI=1", async () => {
    seedVitestPackage();
    const runner = await createJsRunner(dir);
    await runner.runTests(dir, "src/foo.test.ts");
    expect(runSpy).toHaveBeenCalledWith(
      join(dir, "node_modules", ".bin", "vitest"),
      ["run", "src/foo.test.ts"],
      expect.objectContaining({ cwd: dir, env: { CI: "1" } }),
    );
  });

  it("builds vitest runTestsOnPaths argv for multiple paths", async () => {
    seedVitestPackage();
    const runner = await createJsRunner(dir);
    await runner.runTestsOnPaths(dir, ["a.test.ts", "b.test.ts"]);
    expect(runSpy).toHaveBeenCalledWith(
      join(dir, "node_modules", ".bin", "vitest"),
      ["run", "a.test.ts", "b.test.ts"],
      expect.objectContaining({ cwd: dir }),
    );
  });

  it("builds vitest verbose argv", async () => {
    seedVitestPackage();
    const runner = await createJsRunner(dir);
    await runner.runTestsVerbose(dir);
    expect(runSpy).toHaveBeenCalledWith(
      join(dir, "node_modules", ".bin", "vitest"),
      ["run", "--reporter=verbose"],
      expect.objectContaining({ cwd: dir }),
    );
  });

  it("builds jest runTests argv omitting path when undefined", async () => {
    seedJestPackage();
    const runner = await createJsRunner(dir);
    await runner.runTests(dir);
    expect(runSpy).toHaveBeenCalledWith(
      join(dir, "node_modules", ".bin", "jest"),
      ["--ci"],
      expect.objectContaining({ cwd: dir }),
    );
  });

  it("builds jest runTests argv with path when provided", async () => {
    seedJestPackage();
    const runner = await createJsRunner(dir);
    await runner.runTests(dir, "src/foo.test.ts");
    expect(runSpy).toHaveBeenCalledWith(
      join(dir, "node_modules", ".bin", "jest"),
      ["--ci", "src/foo.test.ts"],
      expect.objectContaining({ cwd: dir }),
    );
  });

  it("uses the vitest red prompt rule text", async () => {
    seedVitestPackage();
    const runner = await createJsRunner(dir);
    expect(runner.redPromptRules).toBe(VITEST_RED_PROMPT_RULES);
    expect(runner.language).toBe("js");
    expect(runner.testFrameworkName).toBe("vitest");
  });

  it("builds jest verbose and runTestsOnPaths argv", async () => {
    seedJestPackage();
    const runner = await createJsRunner(dir);
    await runner.runTestsVerbose(dir);
    expect(runSpy).toHaveBeenCalledWith(
      join(dir, "node_modules", ".bin", "jest"),
      ["--ci", "--verbose"],
      expect.objectContaining({ cwd: dir }),
    );

    await runner.runTestsOnPaths(dir, ["a.test.ts", "b.test.ts"]);
    expect(runSpy).toHaveBeenCalledWith(
      join(dir, "node_modules", ".bin", "jest"),
      ["--ci", "a.test.ts", "b.test.ts"],
      expect.objectContaining({ cwd: dir }),
    );
  });

  it("uses the package dir inside a monorepo worktree as cwd", async () => {
    dir = mkdtempSync(join(tmpdir(), "js-runner-"));
    initGit(dir);
    const pkgDir = join(dir, "packages", "core");
    mkdirSync(pkgDir, { recursive: true });
    writeJson(join(dir, "package.json"), { devDependencies: { vitest: "^1.0.0" } });
    writeJson(join(pkgDir, "package.json"), { name: "core" });
    writeFileSync(join(dir, "pnpm-lock.yaml"), "");
    mkdirSync(join(dir, "node_modules", ".bin"), { recursive: true });
    writeFileSync(join(dir, "node_modules", ".bin", "vitest"), "#!/usr/bin/env node\n");

    const runner = await createJsRunner(pkgDir);
    await runner.runTests(dir, "packages/core/src/foo.test.ts");
    expect(runSpy).toHaveBeenCalledWith(
      join(dir, "node_modules", ".bin", "vitest"),
      ["run", "src/foo.test.ts"],
      expect.objectContaining({ cwd: pkgDir }),
    );
  });

  it("installs and runs from web/ subdir when workspace differs from git root", async () => {
    dir = mkdtempSync(join(tmpdir(), "js-runner-"));
    initGit(dir);
    const webDir = join(dir, "web");
    mkdirSync(webDir, { recursive: true });
    writeJson(join(webDir, "package.json"), { devDependencies: { vitest: "^1.0.0" } });
    writeFileSync(join(webDir, "package-lock.json"), "");
    mkdirSync(join(webDir, "node_modules", ".bin"), { recursive: true });
    writeFileSync(join(webDir, "node_modules", ".bin", "vitest"), "#!/usr/bin/env node\n");

    const runner = await createJsRunner(webDir);
    await runner.ensureEnv(dir);
    expect(runSpy).toHaveBeenCalledWith(
      "npm",
      ["ci"],
      expect.objectContaining({ cwd: webDir }),
    );

    runSpy.mockClear();
    await runner.runTests(dir, "web/src/foo.test.ts");
    expect(runSpy).toHaveBeenCalledWith(
      join(webDir, "node_modules", ".bin", "vitest"),
      ["run", "src/foo.test.ts"],
      expect.objectContaining({ cwd: webDir }),
    );
  });

  it("testPathKey strips package prefix for git-root-relative paths", async () => {
    dir = mkdtempSync(join(tmpdir(), "js-runner-"));
    initGit(dir);
    const webDir = join(dir, "web");
    mkdirSync(webDir, { recursive: true });
    writeJson(join(webDir, "package.json"), { devDependencies: { vitest: "^1.0.0" } });
    writeFileSync(join(webDir, "package-lock.json"), "");

    const runner = await createJsRunner(webDir);
    expect(runner.testPathKey("web/src/foo.test.ts")).toBe("src/foo.test.ts");
  });
});

describe("createJsRunner ensureEnv", () => {
  let dir: string;
  let runSpy: ReturnType<typeof vi.spyOn>;

  afterEach(() => {
    runSpy.mockRestore();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  beforeEach(() => {
    runSpy = vi.spyOn(jsRunnerDeps, "runCommand").mockResolvedValue({
      exitCode: 0,
      stdout: "",
      stderr: "",
    });
  });

  it("installs at the mapped workspace root inside the worktree", async () => {
    dir = mkdtempSync(join(tmpdir(), "js-runner-"));
    initGit(dir);
    const pkgDir = join(dir, "packages", "core");
    mkdirSync(pkgDir, { recursive: true });
    writeJson(join(dir, "package.json"), { name: "root" });
    writeJson(join(pkgDir, "package.json"), { name: "core", devDependencies: { vitest: "^1.0.0" } });
    writeFileSync(join(dir, "pnpm-lock.yaml"), "");

    const runner = await createJsRunner(pkgDir);
    await runner.ensureEnv(dir);

    expect(runSpy).toHaveBeenCalledWith(
      "pnpm",
      ["install", "--prefer-offline"],
      expect.objectContaining({ cwd: dir, timeoutMs: 300_000 }),
    );
  });

  it("falls back from npm ci to npm install on failure", async () => {
    dir = mkdtempSync(join(tmpdir(), "js-runner-"));
    initGit(dir);
    writeJson(join(dir, "package.json"), { devDependencies: { vitest: "^1.0.0" } });
    writeFileSync(join(dir, "package-lock.json"), "");

    runSpy
      .mockResolvedValueOnce({ exitCode: 1, stdout: "ci failed", stderr: "" })
      .mockResolvedValueOnce({ exitCode: 0, stdout: "", stderr: "" });

    const runner = await createJsRunner(dir);
    await runner.ensureEnv(dir);

    expect(runSpy).toHaveBeenNthCalledWith(1, "npm", ["ci"], expect.objectContaining({ cwd: dir }));
    expect(runSpy).toHaveBeenNthCalledWith(2, "npm", ["install"], expect.objectContaining({ cwd: dir }));
  });

  it("throws with raw output when install fails", async () => {
    dir = mkdtempSync(join(tmpdir(), "js-runner-"));
    initGit(dir);
    writeJson(join(dir, "package.json"), { devDependencies: { vitest: "^1.0.0" } });
    writeFileSync(join(dir, "package-lock.json"), "");
    runSpy.mockResolvedValue({ exitCode: 1, stdout: "stdout err", stderr: "stderr err" });

    const runner = await createJsRunner(dir);
    await expect(runner.ensureEnv(dir)).rejects.toThrow("stdout errstderr err");
  });
});

describe("createJsRunner runStaticGates", () => {
  let dir: string;
  let runSpy: ReturnType<typeof vi.spyOn>;

  afterEach(() => {
    runSpy.mockRestore();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  beforeEach(() => {
    runSpy = vi.spyOn(jsRunnerDeps, "runCommand").mockResolvedValue({
      exitCode: 0,
      stdout: "",
      stderr: "",
    });
  });

  it("runs tsc --noEmit when tsc and tsconfig resolve in the worktree", async () => {
    dir = mkdtempSync(join(tmpdir(), "js-runner-"));
    initGit(dir);
    writeJson(join(dir, "package.json"), { devDependencies: { vitest: "^1.0.0", typescript: "^5.0.0" } });
    writeJson(join(dir, "tsconfig.json"), { compilerOptions: { strict: true } });
    mkdirSync(join(dir, "node_modules", ".bin"), { recursive: true });
    writeFileSync(join(dir, "node_modules", ".bin", "vitest"), "#!/usr/bin/env node\n");
    writeFileSync(join(dir, "node_modules", ".bin", "tsc"), "#!/usr/bin/env node\n");

    const runner = await createJsRunner(dir);
    const gates = await runner.runStaticGates(dir);

    expect(gates).toEqual([
      { name: "tsc --noEmit", passed: true, raw: "" },
    ]);
    expect(runSpy).toHaveBeenCalledWith(
      join(dir, "node_modules", ".bin", "tsc"),
      ["--noEmit", "-p", join(dir, "tsconfig.json")],
      expect.objectContaining({ cwd: dir, timeoutMs: 120_000 }),
    );
  });

  it("returns an empty list when tsc or tsconfig is missing", async () => {
    dir = mkdtempSync(join(tmpdir(), "js-runner-"));
    initGit(dir);
    writeJson(join(dir, "package.json"), { devDependencies: { vitest: "^1.0.0" } });
    mkdirSync(join(dir, "node_modules", ".bin"), { recursive: true });
    writeFileSync(join(dir, "node_modules", ".bin", "vitest"), "#!/usr/bin/env node\n");

    const runner = await createJsRunner(dir);
    expect(await runner.runStaticGates(dir)).toEqual([]);
    expect(runSpy).not.toHaveBeenCalled();
  });
});

describe("createJsRunner predicates", () => {
  it("identifies source and test files", async () => {
    const dir = mkdtempSync(join(tmpdir(), "js-runner-"));
    initGit(dir);
    writeJson(join(dir, "package.json"), { devDependencies: { vitest: "^1.0.0" } });
    const runner = await createJsRunner(dir);
    expect(runner.isSourceFile("src/foo.ts")).toBe(true);
    expect(runner.isSourceFile("src/foo.d.ts")).toBe(false);
    expect(runner.isSourceFile("node_modules/foo.ts")).toBe(false);
    expect(runner.isTestFile("src/foo.test.ts")).toBe(true);
    expect(runner.isTestFile("src/__tests__/foo.ts")).toBe(true);
    expect(runner.isTestFile("src/foo.ts")).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("createJsRunner lintRedTest", () => {
  it("passes lint for expect-based tests with multiple assertions", async () => {
    const dir = mkdtempSync(join(tmpdir(), "js-runner-"));
    initGit(dir);
    writeJson(join(dir, "package.json"), { devDependencies: { vitest: "^1.0.0" } });
    const runner = await createJsRunner(dir);
    const result = runner.lintRedTest(
      "import { describe, expect, it } from 'vitest';\n" +
        "describe('add', () => {\n" +
        "  it('adds', () => {\n" +
        "    expect(1 + 1).toBe(2);\n" +
        "    expect(2 + 2).toBe(4);\n" +
        "  });\n" +
        "});\n",
    );
    expect(result.blocking).toEqual([]);
    expect(result.warnings.some((w) => /triangulat/.test(w))).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  it("blocks an empty test file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "js-runner-"));
    initGit(dir);
    writeJson(join(dir, "package.json"), { devDependencies: { vitest: "^1.0.0" } });
    const runner = await createJsRunner(dir);
    expect(runner.lintRedTest("").blocking).toContain("test file is empty");
    rmSync(dir, { recursive: true, force: true });
  });

  it("blocks a test file with no assertions", async () => {
    const dir = mkdtempSync(join(tmpdir(), "js-runner-"));
    initGit(dir);
    writeJson(join(dir, "package.json"), { devDependencies: { vitest: "^1.0.0" } });
    const runner = await createJsRunner(dir);
    const result = runner.lintRedTest("describe('x', () => { it('y', () => {}); });\n");
    expect(result.blocking).toContain("no assertions found (expect(...) or assert)");
    rmSync(dir, { recursive: true, force: true });
  });

  it("warns on a single expect assertion", async () => {
    const dir = mkdtempSync(join(tmpdir(), "js-runner-"));
    initGit(dir);
    writeJson(join(dir, "package.json"), { devDependencies: { vitest: "^1.0.0" } });
    const runner = await createJsRunner(dir);
    const result = runner.lintRedTest("it('adds', () => { expect(1 + 1).toBe(2); });\n");
    expect(result.blocking).toEqual([]);
    expect(result.warnings.some((w) => /triangulat/.test(w))).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });
});
