import { describe, expect, it } from "vitest";
import { runCommand } from "../src/exec.js";

describe("runCommand", () => {
  it("captures stdout and a zero exit code on success", async () => {
    const result = await runCommand("node", ["-e", "console.log('hello')"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("hello");
  });

  it("captures a non-zero exit code and stderr on failure", async () => {
    const result = await runCommand("node", [
      "-e",
      "console.error('boom'); process.exit(3)",
    ]);
    expect(result.exitCode).toBe(3);
    expect(result.stderr.trim()).toBe("boom");
  });

  it("respects the cwd option", async () => {
    const result = await runCommand("pwd", [], { cwd: "/tmp" });
    expect(result.stdout.trim()).toBe("/tmp");
  });

  it("rejects if the command does not finish within timeoutMs", async () => {
    await expect(
      runCommand("node", ["-e", "setTimeout(() => {}, 5000)"], {
        timeoutMs: 200,
      }),
    ).rejects.toThrow(/timed out/i);
  });
});
