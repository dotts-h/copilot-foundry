import { runCommand } from "../exec.js";

export interface DiffGuardResult {
  violated: boolean;
  offendingPaths: string[];
}

function parsePorcelainPath(line: string): string | null {
  const trimmed = line.trim();
  if (trimmed.length < 4) {
    return null;
  }
  const pathPart = line.slice(3);
  const arrowIndex = pathPart.indexOf(" -> ");
  if (arrowIndex !== -1) {
    return pathPart.slice(0, arrowIndex);
  }
  return pathPart;
}

export async function checkDiffGuard(
  cwd: string,
  lockedPaths: string[],
): Promise<DiffGuardResult> {
  const result = await runCommand("git", ["status", "--porcelain=v1"], { cwd });
  const changedPaths = new Set<string>();

  for (const line of result.stdout.split("\n")) {
    const path = parsePorcelainPath(line);
    if (path !== null) {
      changedPaths.add(path);
    }
  }

  const offendingPaths = lockedPaths.filter((lockedPath) =>
    changedPaths.has(lockedPath),
  );

  return {
    violated: offendingPaths.length > 0,
    offendingPaths,
  };
}

export async function revertPaths(cwd: string, paths: string[]): Promise<void> {
  await runCommand("git", ["checkout", "--", ...paths], { cwd });
}
