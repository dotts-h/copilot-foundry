import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { removeLeashConfig, writeLeashConfig } from "../../src/backend/cursorLeash.js";
import { runCommand } from "../../src/exec.js";

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

  it("the generated script allows a command naming a file that merely embeds a locked filename", async () => {
    await writeLeashConfig(dir, ["add_kata.py"]);
    const scriptPath = join(dir, ".cursor", "hooks", "deny-locked.sh");
    const allowInput = JSON.stringify({ command: "pytest test_add_kata.py" });
    const { stdout: allowStdout } = await runCommand("bash", ["-c", `printf '%s' '${allowInput}' | '${scriptPath}'`]);
    expect(JSON.parse(allowStdout).permission).toBe("allow");

    const denyInput = JSON.stringify({ command: "pytest add_kata.py" });
    const { stdout: denyStdout } = await runCommand("bash", ["-c", `printf '%s' '${denyInput}' | '${scriptPath}'`]);
    expect(JSON.parse(denyStdout).permission).toBe("deny");
  });

  it("removeLeashConfig deletes only the files we wrote and leaves a pre-existing .cursor dir intact", async () => {
    mkdirSync(join(dir, ".cursor"), { recursive: true });
    writeFileSync(join(dir, ".cursor", "user-settings.json"), "{}");
    await writeLeashConfig(dir, ["locked.py"]);
    await removeLeashConfig(dir);
    expect(existsSync(join(dir, ".cursor", "hooks.json"))).toBe(false);
    expect(existsSync(join(dir, ".cursor", "hooks"))).toBe(false);
    expect(existsSync(join(dir, ".cursor", "user-settings.json"))).toBe(true); // untouched
  });
});
