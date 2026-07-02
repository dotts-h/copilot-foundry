import { join } from "node:path";
import { runCommand } from "./exec.js";

export interface PytestResult {
  exitCode: number;
  raw: string;
}

export async function runPytest(
  venvDir: string,
  cwd: string,
  targetRelPath?: string,
): Promise<PytestResult> {
  const pytestBin = join(venvDir, "bin", "pytest");
  const result = await runCommand(pytestBin, ["-q", "-o", "addopts=", targetRelPath ?? "."], {
    cwd,
    env: { PYTHONDONTWRITEBYTECODE: "1" },
    timeoutMs: 60_000,
  });
  return {
    exitCode: result.exitCode,
    raw: result.stdout + result.stderr,
  };
}
