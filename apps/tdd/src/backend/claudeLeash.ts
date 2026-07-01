import { isAbsolute, resolve } from "node:path";

export interface LeashDecision {
  deny: boolean;
  reason?: string;
}

export function evaluateLeash(
  cwd: string,
  lockedPaths: string[],
  toolName: string,
  toolInput: Record<string, unknown>,
): LeashDecision {
  if (lockedPaths.length === 0) return { deny: false };
  const lockedAbs = lockedPaths.map((p) => resolve(cwd, p));

  const fileParam = toolInput.file_path ?? toolInput.notebook_path;
  if (typeof fileParam === "string") {
    const abs = isAbsolute(fileParam) ? resolve(fileParam) : resolve(cwd, fileParam);
    if (lockedAbs.includes(abs)) {
      return { deny: true, reason: `path is leashed by helm-tdd: ${fileParam}` };
    }
  }

  if (toolName === "Bash" && typeof toolInput.command === "string") {
    const hit = lockedPaths.find((p) => (toolInput.command as string).includes(p));
    if (hit !== undefined) {
      return { deny: true, reason: `command touches a path leashed by helm-tdd: ${hit}` };
    }
  }

  return { deny: false };
}
