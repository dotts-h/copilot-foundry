import { copyFile, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { TargetRunner } from "../runner/types.js";

export interface ConstantMutantCheckOptions {
  workDir: string;
  runner: TargetRunner;
  implRelPath: string;
  mutantSourcePath: string;
  testRelPath: string;
}

export interface ConstantMutantResult {
  mutantSurvived: boolean;
}

export async function checkConstantMutant(
  opts: ConstantMutantCheckOptions,
): Promise<ConstantMutantResult> {
  const implPath = join(opts.workDir, opts.implRelPath);
  const original = await readFile(implPath);

  try {
    await copyFile(opts.mutantSourcePath, implPath);
    const pytestResult = await opts.runner.runTests(opts.workDir, opts.testRelPath);
    return { mutantSurvived: opts.runner.classifyRun(pytestResult) === "passed" };
  } finally {
    await writeFile(implPath, original);
  }
}
