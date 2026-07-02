import type { Language, WorkflowScope } from "../types.js";
import type { RepoMap } from "./map.js";

export interface ScopeReport {
  inScope: string[];
  reason: string;
}

function moduleNameFromRelPath(relPath: string): string {
  return relPath.replace(/\.py$/, "").replace(/\//g, ".");
}

function reverseDependents(map: RepoMap, targetRelPath: string): string[] {
  const targetModule = moduleNameFromRelPath(targetRelPath);
  const dependents: string[] = [];
  for (const [file, imports] of Object.entries(map.imports)) {
    if (file === targetRelPath) continue;
    if (imports.some((imp) => imp === targetModule || imp.startsWith(`${targetModule}.`))) {
      dependents.push(file);
    }
  }
  return dependents;
}

export function computeScope(
  map: RepoMap,
  targetHint: string | undefined,
  scopeLevel: WorkflowScope,
  language: Language,
  modulePath?: string,
): ScopeReport {
  if (targetHint === undefined) {
    return {
      inScope: [...map.files],
      reason: "no targetHint given; conservative default is the whole repo",
    };
  }

  if (!map.files.includes(targetHint)) {
    return {
      inScope: [...map.files],
      reason: `targetHint "${targetHint}" not found in repo map; falling back to the whole repo`,
    };
  }

  if (scopeLevel === "repo") {
    return { inScope: [...map.files], reason: "scope=repo" };
  }

  if (scopeLevel === "package") {
    const dir = targetHint.includes("/") ? targetHint.slice(0, targetHint.lastIndexOf("/")) : "";
    const inPackage = map.files.filter((f) => (dir === "" ? !f.includes("/") : f.startsWith(`${dir}/`)));
    return { inScope: inPackage, reason: `scope=package, directory "${dir || "."}"` };
  }

  const dependents = reverseDependents(map, targetHint);
  const inScope = [targetHint, ...dependents];
  return { inScope, reason: `scope=${scopeLevel}, target + ${dependents.length} reverse-dependent file(s)` };
}
