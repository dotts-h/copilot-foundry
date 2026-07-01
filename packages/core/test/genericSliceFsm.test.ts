import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCommand } from "../src/exec.js";
import { runGenericSlice } from "../src/genericSliceFsm.js";
import { JavaScriptAdapter, PythonAdapter } from "../src/languages/adapter.js";
import { ScriptedBackend, writeImpl } from "./helpers/fakeBackend.js";

const FIXTURE_VENV = join(process.cwd(), "fixtures", "add-kata", ".venv");

async function seedGitRepo(setup: (dir: string) => void): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "generic-slice-"));
  setup(dir);
  await runCommand("git", ["init", "-q"], { cwd: dir });
  await runCommand("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  await runCommand("git", ["config", "user.name", "Test"], { cwd: dir });
  await runCommand("git", ["add", "-A"], { cwd: dir });
  await runCommand("git", ["commit", "-q", "-m", "seed"], { cwd: dir });
  return dir;
}

describe("runGenericSlice", () => {
  let dir: string;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("completes a RED->GREEN slice using the Python adapter", async () => {
    dir = await seedGitRepo((d) => {
      writeFileSync(join(d, "add_kata.py"), "def add(a, b):\n    raise NotImplementedError\n");
    });

    const backend = new ScriptedBackend([
      async (opts) => {
        writeFileSync(
          join(opts.cwd, "test_add_kata.py"),
          "from add_kata import add\n\ndef test_add():\n    assert add(2, 3) == 5\n",
        );
      },
      async (opts) => writeImpl(opts.cwd, "add_kata.py", "def add(a, b):\n    return a + b\n"),
    ]);

    const ledger = await runGenericSlice(
      {
        targetDir: dir,
        language: new PythonAdapter(FIXTURE_VENV),
        redModel: "fake-red",
        greenModel: "fake-green",
        testRelPath: "test_add_kata.py",
        redPrompt: "write a failing test",
        greenPrompt: "make it pass",
      },
      backend,
      "run-generic-python",
    );

    expect(ledger.language).toBe("python");
    expect(ledger.redGatePassed).toBe(true);
    expect(ledger.greenGatePassed).toBe(true);
  });

  it("completes a RED->GREEN slice using the JavaScript adapter", async () => {
    dir = await seedGitRepo((d) => {
      writeFileSync(
        join(d, "add_kata.js"),
        "function add(a, b) {\n  throw new Error('not implemented');\n}\n\nmodule.exports = { add };\n",
      );
      mkdirSync(join(d, "test"));
    });

    const backend = new ScriptedBackend([
      async (opts) => {
        writeFileSync(
          join(opts.cwd, "test", "add_kata.test.js"),
          "const { test } = require('node:test');\nconst assert = require('node:assert');\n" +
            "const { add } = require('../add_kata.js');\n\n" +
            "test('add(2, 3) returns 5', () => { assert.strictEqual(add(2, 3), 5); });\n",
        );
      },
      async (opts) =>
        writeImpl(opts.cwd, "add_kata.js", "function add(a, b) {\n  return a + b;\n}\n\nmodule.exports = { add };\n"),
    ]);

    const ledger = await runGenericSlice(
      {
        targetDir: dir,
        language: new JavaScriptAdapter(),
        redModel: "fake-red",
        greenModel: "fake-green",
        testRelPath: "test/add_kata.test.js",
        redPrompt: "write a failing test",
        greenPrompt: "make it pass",
      },
      backend,
      "run-generic-js",
    );

    expect(ledger.language).toBe("javascript");
    expect(ledger.redGatePassed).toBe(true);
    expect(ledger.greenGatePassed).toBe(true);
  });

  it("reverts and reports diffGuardViolated when GREEN edits the locked test file, language-agnostically", async () => {
    dir = await seedGitRepo((d) => {
      writeFileSync(join(d, "add_kata.py"), "def add(a, b):\n    raise NotImplementedError\n");
    });

    const backend = new ScriptedBackend([
      async (opts) => {
        writeFileSync(
          join(opts.cwd, "test_add_kata.py"),
          "from add_kata import add\n\ndef test_add():\n    assert add(2, 3) == 5\n",
        );
      },
      async (opts) => {
        await writeImpl(opts.cwd, "add_kata.py", "def add(a, b):\n    return a + b\n");
        await writeImpl(opts.cwd, "test_add_kata.py", "def test_add():\n    assert True\n");
      },
    ]);

    const ledger = await runGenericSlice(
      {
        targetDir: dir,
        language: new PythonAdapter(FIXTURE_VENV),
        redModel: "fake-red",
        greenModel: "fake-green",
        testRelPath: "test_add_kata.py",
        redPrompt: "write a failing test",
        greenPrompt: "make it pass",
      },
      backend,
      "run-generic-leash",
    );

    expect(ledger.diffGuardViolated).toBe(true);
    expect(ledger.greenGatePassed).toBe(true);
  });
});
