import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCommand } from "../../src/exec.js";
import { detectLanguage, resolveRunner } from "../../src/runner/resolve.js";

const KATA_TS = join(process.cwd(), "kata-ts");
const KATA_GO = join(process.cwd(), "kata-go");
const ADD_KATA = join(process.cwd(), "fixtures", "add-kata");
const FIXTURE_VENV = join(ADD_KATA, ".venv");

async function initGitRepo(dir: string): Promise<void> {
  await runCommand("git", ["init", "-q"], { cwd: dir });
  await runCommand("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  await runCommand("git", ["config", "user.name", "Test"], { cwd: dir });
  await runCommand("git", ["add", "-A"], { cwd: dir });
  await runCommand("git", ["commit", "-q", "-m", "seed"], { cwd: dir });
}

describe("detectLanguage", () => {
  it("detects js on kata-ts", async () => {
    await expect(detectLanguage(KATA_TS)).resolves.toBe("js");
  });

  it("detects go on kata-go", async () => {
    await expect(detectLanguage(KATA_GO)).resolves.toBe("go");
  });

  it("detects python on add-kata", async () => {
    await expect(detectLanguage(ADD_KATA)).resolves.toBe("python");
  });
});

describe("detectLanguage precedence", () => {
  let dir: string;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("prefers go when go.mod and package.json both exist", async () => {
    dir = mkdtempSync(join(tmpdir(), "resolve-go-js-"));
    writeFileSync(join(dir, "go.mod"), "module example.com/test\n\ngo 1.22\n");
    writeFileSync(join(dir, "package.json"), "{}");
    await initGitRepo(dir);
    await expect(detectLanguage(dir)).resolves.toBe("go");
  });

  it("prefers python markers over package.json", async () => {
    dir = mkdtempSync(join(tmpdir(), "resolve-py-js-"));
    writeFileSync(join(dir, "requirements.txt"), "pytest\n");
    writeFileSync(join(dir, "package.json"), "{}");
    await initGitRepo(dir);
    await expect(detectLanguage(dir)).resolves.toBe("python");
  });
});

describe("resolveRunner", () => {
  it("throws when python is resolved without venvDir", async () => {
    await expect(resolveRunner({ targetDir: ADD_KATA, language: "python" })).rejects.toThrow(
      "python target requires venvDir",
    );
  });

  it("constructs a python runner when venvDir is provided", async () => {
    const runner = await resolveRunner({ targetDir: ADD_KATA, venvDir: FIXTURE_VENV, language: "python" });
    expect(runner.language).toBe("python");
  });
});
