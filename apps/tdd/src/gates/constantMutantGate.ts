import { copyFile, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runPytest } from "../pythonRunner.js";

export interface ConstantMutantCheckOptions {
  workDir: string;
  venvDir: string;
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
    const pytestResult = await runPytest(opts.venvDir, opts.workDir, opts.testRelPath);
    return { mutantSurvived: pytestResult.exitCode === 0 };
  } finally {
    await writeFile(implPath, original);
  }
}
