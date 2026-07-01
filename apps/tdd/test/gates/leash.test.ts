import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCommand } from "../../src/exec.js";
import { writeLeashConfig } from "../../src/gates/leash.js";

describe("leash config generator", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "leash-test-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("writes hooks.json wiring beforeShellExecution to the generated script", async () => {
    await writeLeashConfig(dir, ["test_add_kata.py"]);
    const hooksJson = JSON.parse(readFileSync(join(dir, ".cursor", "hooks.json"), "utf8"));
    expect(hooksJson.hooks.beforeShellExecution).toEqual([
      { command: join(dir, ".cursor", "hooks", "deny-locked.sh") },
    ]);
  });

  it("writes an executable hook script", async () => {
    await writeLeashConfig(dir, ["test_add_kata.py"]);
    const scriptPath = join(dir, ".cursor", "hooks", "deny-locked.sh");
    expect(existsSync(scriptPath)).toBe(true);
    const { stdout } = await runCommand("stat", ["-c", "%a", scriptPath]);
    expect(stdout.trim().endsWith("7") || stdout.trim().endsWith("5")).toBe(true);
  });

  it("the generated script denies a shell command that references a locked path", async () => {
    await writeLeashConfig(dir, ["test_add_kata.py"]);
    const scriptPath = join(dir, ".cursor", "hooks", "deny-locked.sh");
    const input = JSON.stringify({ command: "sed -i 's/x/y/' test_add_kata.py" });
    const { stdout } = await runCommand("bash", ["-c", `printf '%s' '${input}' | '${scriptPath}'`]);
    const parsed = JSON.parse(stdout);
    expect(parsed.permission).toBe("deny");
  });

  it("the generated script allows a shell command that does not reference a locked path", async () => {
    await writeLeashConfig(dir, ["test_add_kata.py"]);
    const scriptPath = join(dir, ".cursor", "hooks", "deny-locked.sh");
    const input = JSON.stringify({ command: "ls -la" });
    const { stdout } = await runCommand("bash", ["-c", `printf '%s' '${input}' | '${scriptPath}'`]);
    const parsed = JSON.parse(stdout);
    expect(parsed.permission).toBe("allow");
  });
});
