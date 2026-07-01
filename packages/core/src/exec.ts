import { spawn } from "node:child_process";

export interface RunCommandOptions {
  cwd?: string;
  timeoutMs?: number;
  env?: Record<string, string>;
}

export interface RunCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export function runCommand(cmd: string, args: string[], opts?: RunCommandOptions): Promise<RunCommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: opts?.cwd,
      env: opts?.env ? { ...process.env, ...opts.env } : undefined,
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on("error", (err) => {
      if (timeoutId !== undefined) clearTimeout(timeoutId);
      reject(err);
    });

    child.on("close", (code) => {
      if (timeoutId !== undefined) clearTimeout(timeoutId);
      if (timedOut) return;
      resolve({ exitCode: code ?? 0, stdout, stderr });
    });

    if (opts?.timeoutMs !== undefined) {
      timeoutId = setTimeout(() => {
        timedOut = true;
        child.kill();
        reject(new Error("Command timed out"));
      }, opts.timeoutMs);
    }
  });
}
