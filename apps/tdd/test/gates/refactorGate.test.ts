import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runCommand } from "../../src/exec.js";
import { attemptRefactor, measurePythonFile } from "../../src/gates/refactorGate.js";
import { createPythonRunner } from "../../src/runner/pythonRunner.js";
import type { TargetRunner } from "../../src/runner/types.js";
import { ScriptedBackend, writeImpl } from "../helpers/fakeBackend.js";

const FIXTURE_VENV = join(process.cwd(), "fixtures", "add-kata", ".venv");
const runner = createPythonRunner(FIXTURE_VENV);

async function seedRepo(implSource: string): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "refactor-gate-"));
  writeFileSync(join(dir, "add_kata.py"), implSource);
  writeFileSync(
    join(dir, "test_add_kata.py"),
    "from add_kata import add\n\ndef test_add():\n    assert add(2, 3) == 5\n",
  );
  await runCommand("git", ["init", "-q"], { cwd: dir });
  await runCommand("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  await runCommand("git", ["config", "user.name", "Test"], { cwd: dir });
  await runCommand("git", ["add", "-A"], { cwd: dir });
  await runCommand("git", ["commit", "-q", "-m", "seed"], { cwd: dir });
  return dir;
}

const VERBOSE_ADD = "def add(a, b):\n    result = a + b\n    return result\n";
const TIDY_ADD = "def add(a, b):\n    return a + b\n";
const BROKEN_ADD = "def add(a, b):\n    return a - b\n";
const BLOATED_ADD =
  "def add(a, b):\n    # a very padded implementation\n    x = a\n    y = b\n    z = x + y\n    return z\n";
const TWO_FN_SOURCE =
  "def add(a, b):\n    result = a + b\n    return result\n\n\ndef double(x):\n    return x * 2\n";
const OUT_OF_SCOPE_REFACTOR =
  "def add(a, b):\n    return a + b\n\n\ndef double(x):\n    value = x\n    return value * 2\n";
const HELPER_EXTRACT_SOURCE =
  "def add(a, b):\n    x = a\n    y = b\n    result = x + y\n    return result\n";
const HELPER_EXTRACT_REFACTOR =
  "def add(a, b):\n    return _sum_pair(a, b)\n\ndef _sum_pair(a, b):\n    return a + b\n";
const BLANK_LINE_INSERT_SOURCE =
  "def add(a, b):\n    result = a + b\n    return result\n\ndef double(x):\n    return x * 2\n";
const BLANK_LINE_INSERT_REFACTOR =
  "def add(a, b):\n    result = a + b\n    return result\n\n\ndef double(x):\n    return x * 2\n";

const REFACTOR_OPTS_BASE = {
  runner,
  venvDir: FIXTURE_VENV,
  implRelPath: "add_kata.py",
  testRelPath: "test_add_kata.py",
  functionName: "add",
  refactorModel: "fake-refactor",
  buildPrompt: () => "tidy up add_kata.py",
};

describe("measurePythonFile", () => {
  it("counts non-blank lines and the longest function span", async () => {
    const dir = mkdtempSync(join(tmpdir(), "measure-"));
    writeFileSync(join(dir, "add_kata.py"), VERBOSE_ADD);
    const metrics = await measurePythonFile(FIXTURE_VENV, join(dir, "add_kata.py"));
    expect(metrics.totalLines).toBe(3);
    expect(metrics.maxFunctionLines).toBe(3);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("attemptRefactor", () => {
  let dir: string;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("applies a refactor that shrinks the file while keeping tests green", async () => {
    dir = await seedRepo(VERBOSE_ADD);
    const backend = new ScriptedBackend([async (opts) => writeImpl(opts.cwd, "add_kata.py", TIDY_ADD)]);

    const result = await attemptRefactor({
      backend,
      targetDir: dir,
      ...REFACTOR_OPTS_BASE,
    });

    expect(result.applied).toBe(true);
    expect(result.after?.totalLines).toBeLessThan(result.before.totalLines);
    expect(readFileSync(join(dir, "add_kata.py"), "utf8")).toBe(TIDY_ADD);
  });

  it("reverts when the refactor breaks the test", async () => {
    dir = await seedRepo(VERBOSE_ADD);
    const backend = new ScriptedBackend([async (opts) => writeImpl(opts.cwd, "add_kata.py", BROKEN_ADD)]);

    const result = await attemptRefactor({
      backend,
      targetDir: dir,
      ...REFACTOR_OPTS_BASE,
    });

    expect(result.applied).toBe(false);
    expect(result.reason).toMatch(/broke the test/);
    expect(readFileSync(join(dir, "add_kata.py"), "utf8")).toBe(VERBOSE_ADD);
  });

  it("reverts when the refactor keeps tests green but worsens the ratchet", async () => {
    dir = await seedRepo(TIDY_ADD);
    const backend = new ScriptedBackend([async (opts) => writeImpl(opts.cwd, "add_kata.py", BLOATED_ADD)]);

    const result = await attemptRefactor({
      backend,
      targetDir: dir,
      ...REFACTOR_OPTS_BASE,
    });

    expect(result.applied).toBe(false);
    expect(result.reason).toMatch(/ratchet violated/);
    expect(readFileSync(join(dir, "add_kata.py"), "utf8")).toBe(TIDY_ADD);
  });

  it("reverts the test file and still judges correctly when the refactor phase edits the locked test file", async () => {
    dir = await seedRepo(VERBOSE_ADD);
    const backend = new ScriptedBackend([
      async (opts) => {
        await writeImpl(opts.cwd, "add_kata.py", TIDY_ADD);
        await writeImpl(opts.cwd, "test_add_kata.py", "def test_add():\n    assert True\n");
      },
    ]);

    const result = await attemptRefactor({
      backend,
      targetDir: dir,
      ...REFACTOR_OPTS_BASE,
    });

    const testFileAfter = readFileSync(join(dir, "test_add_kata.py"), "utf8");
    expect(testFileAfter).toContain("assert add(2, 3) == 5");
    expect(result.applied).toBe(true);
  });

  describe("scope bounding", () => {
    it("applies a refactor that edits only inside the slice function", async () => {
      dir = await seedRepo(VERBOSE_ADD);
      const backend = new ScriptedBackend([async (opts) => writeImpl(opts.cwd, "add_kata.py", TIDY_ADD)]);

      const result = await attemptRefactor({
        backend,
        targetDir: dir,
        ...REFACTOR_OPTS_BASE,
      });

      expect(result.applied).toBe(true);
      expect(result.scopeViolation).toBeNull();
      expect(result.scopeCheck).toBe("enforced");
      expect(readFileSync(join(dir, "add_kata.py"), "utf8")).toBe(TIDY_ADD);
    });

    it("reverts when the refactor edits another function in the same file", async () => {
      dir = await seedRepo(TWO_FN_SOURCE);
      const backend = new ScriptedBackend([
        async (opts) => writeImpl(opts.cwd, "add_kata.py", OUT_OF_SCOPE_REFACTOR),
      ]);

      const result = await attemptRefactor({
        backend,
        targetDir: dir,
        ...REFACTOR_OPTS_BASE,
      });

      expect(result.applied).toBe(false);
      expect(result.reason).toMatch(/exceeded slice scope/);
      expect(result.scopeViolation?.offendingHunks.length).toBeGreaterThan(0);
      expect(result.scopeCheck).toBe("enforced");
      expect(readFileSync(join(dir, "add_kata.py"), "utf8")).toBe(TWO_FN_SOURCE);
    });

    it("applies a refactor that extracts a helper called from the slice function", async () => {
      dir = await seedRepo(HELPER_EXTRACT_SOURCE);
      const backend = new ScriptedBackend([
        async (opts) => writeImpl(opts.cwd, "add_kata.py", HELPER_EXTRACT_REFACTOR),
      ]);

      const result = await attemptRefactor({
        backend,
        targetDir: dir,
        ...REFACTOR_OPTS_BASE,
      });

      expect(result.applied).toBe(true);
      expect(result.scopeViolation).toBeNull();
      expect(result.scopeCheck).toBe("enforced");
      expect(readFileSync(join(dir, "add_kata.py"), "utf8")).toBe(HELPER_EXTRACT_REFACTOR);
    });

    it("applies a refactor that only inserts a blank line elsewhere in the file", async () => {
      dir = await seedRepo(BLANK_LINE_INSERT_SOURCE);
      const backend = new ScriptedBackend([
        async (opts) => writeImpl(opts.cwd, "add_kata.py", BLANK_LINE_INSERT_REFACTOR),
      ]);

      const result = await attemptRefactor({
        backend,
        targetDir: dir,
        ...REFACTOR_OPTS_BASE,
      });

      expect(result.applied).toBe(true);
      expect(result.scopeViolation).toBeNull();
      expect(result.scopeCheck).toBe("enforced");
      expect(readFileSync(join(dir, "add_kata.py"), "utf8")).toBe(BLANK_LINE_INSERT_REFACTOR);
    });

    it("skips scope bounding when functionSpans returns an empty list", async () => {
      dir = await seedRepo(VERBOSE_ADD);
      const backend = new ScriptedBackend([async (opts) => writeImpl(opts.cwd, "add_kata.py", TIDY_ADD)]);
      const noSpansRunner: TargetRunner = {
        ...runner,
        functionSpans: vi.fn(async () => []),
      };

      const result = await attemptRefactor({
        backend,
        targetDir: dir,
        ...REFACTOR_OPTS_BASE,
        runner: noSpansRunner,
      });

      expect(result.applied).toBe(true);
      expect(result.scopeCheck).toBe("skipped_no_spans");
      expect(result.scopeViolation).toBeNull();
      expect(readFileSync(join(dir, "add_kata.py"), "utf8")).toBe(TIDY_ADD);
    });
  });
});
