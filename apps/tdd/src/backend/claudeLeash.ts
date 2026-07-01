import { isAbsolute, resolve, sep } from "node:path";

const WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
}

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
  if (WRITE_TOOLS.has(toolName) && typeof fileParam === "string") {
    const abs = isAbsolute(fileParam) ? resolve(fileParam) : resolve(cwd, fileParam);
    const workspaceRoot = resolve(cwd);
    if (abs !== workspaceRoot && !abs.startsWith(workspaceRoot + sep)) {
      return { deny: true, reason: `path is outside the helm-tdd workspace (${workspaceRoot}): ${fileParam}` };
    }
    if (lockedAbs.includes(abs)) {
      return { deny: true, reason: `path is leashed by helm-tdd (writes forbidden): ${fileParam}` };
    }
  }

  if (toolName === "Bash" && typeof toolInput.command === "string") {
    const command = toolInput.command;
    const hit = lockedPaths.find((p) => new RegExp(`(^|[^\\w.-])${escapeRegExp(p)}`).test(command));
    if (hit !== undefined) {
      return {
        deny: true,
        reason: `command touches a path leashed by helm-tdd: ${hit} (writes to it are forbidden; use the Read tool for read-only access)`,
      };
    }
  }

  return { deny: false };
}
