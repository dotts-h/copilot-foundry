import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { runCommand } from "./exec.js";
import type { BaselineTestResult, TestOutcome } from "./phases/baseline.js";

const GO_TEST_TIMEOUT_MS = 300_000;

const OUTCOME_BY_ACTION: Record<string, TestOutcome> = {
  pass: "passed",
  fail: "failed",
  skip: "skipped",
};

interface GoTestJsonEvent {
  Action?: string;
  Package?: string;
  Test?: string;
}

export function parseGoTestJson(raw: string): { tests: BaselineTestResult[]; buildFailed: boolean } {
  const tests: BaselineTestResult[] = [];
  let buildFailed = raw.includes("[build failed]");

  for (const line of raw.split("\n")) {
    if (line.trim() === "") continue;
    let event: GoTestJsonEvent;
    try {
      event = JSON.parse(line) as GoTestJsonEvent;
    } catch {
      continue;
    }

    if (event.Action === "build-fail") {
      buildFailed = true;
      continue;
    }

    if (event.Test !== undefined && event.Action !== undefined && event.Action in OUTCOME_BY_ACTION) {
      tests.push({
        nodeId: `${event.Package}::${event.Test}`,
        outcome: OUTCOME_BY_ACTION[event.Action],
      });
    }
  }

  return { tests, buildFailed };
}

async function runGo(args: string[], cwd: string): Promise<{ exitCode: number; raw: string }> {
  try {
    const result = await runCommand("go", args, { cwd, timeoutMs: GO_TEST_TIMEOUT_MS });
    return { exitCode: result.exitCode, raw: result.stdout + result.stderr };
  } catch (err) {
    if (err && typeof err === "object" && (err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error("goRunner: the go toolchain was not found on PATH");
    }
    throw err;
  }
}

function goPackageArg(targetRelPath: string): string {
  const dir = dirname(targetRelPath);
  return dir === "." ? "./" : `./${dir}/`;
}

export async function runGoTest(
  cwd: string,
  targetRelPath?: string,
): Promise<{ verdict: "passed" | "tests_failed" | "infra_error"; raw: string }> {
  const pkg = targetRelPath === undefined ? "./..." : goPackageArg(targetRelPath);
  const { exitCode, raw } = await runGo(["test", "-json", pkg], cwd);
  const { buildFailed } = parseGoTestJson(raw);

  let verdict: "passed" | "tests_failed" | "infra_error";
  if (exitCode === 0) {
    verdict = "passed";
  } else if (buildFailed) {
    verdict = "infra_error";
  } else {
    verdict = "tests_failed";
  }

  return { verdict, raw };
}

export async function runGoTestVerbose(
  cwd: string,
): Promise<{ tests: BaselineTestResult[]; raw: string }> {
  const { raw } = await runGo(["test", "-json", "./..."], cwd);
  const { tests } = parseGoTestJson(raw);
  return { tests, raw };
}

export async function goModulePath(cwd: string): Promise<string> {
  const goModPath = join(cwd, "go.mod");
  let content: string;
  try {
    content = await readFile(goModPath, "utf8");
  } catch {
    throw new Error(`goRunner: no go.mod found at ${goModPath}`);
  }

  const match = content.match(/^module\s+(\S+)/m);
  if (!match) {
    throw new Error(`goRunner: go.mod at ${goModPath} has no module declaration`);
  }
  return match[1];
}

export function goPathUnit(modulePath: string, relPath: string): string {
  const dir = dirname(relPath);
  return dir === "." ? modulePath : `${modulePath}/${dir}`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function isGoMissingSymbolError(raw: string, functionName: string): boolean {
  const pattern = new RegExp(`undefined: (\\w+\\.)?${escapeRegExp(functionName)}\\b`);
  return pattern.test(raw);
}
