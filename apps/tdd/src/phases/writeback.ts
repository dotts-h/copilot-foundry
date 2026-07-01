import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runCommand } from "../exec.js";

export interface WritebackInputSlice {
  description: string;
  implRelPath: string;
  testRelPath: string;
  greenGatePassed: boolean;
  refactorApplied: boolean;
  mutationScore: number;
}

export interface WritebackResult {
  memoryFilePath: string;
  committed: boolean;
}

function buildMemoryMarkdown(runId: string, featureDescription: string, slices: WritebackInputSlice[]): string {
  const lines = [`# helm-tdd run ${runId}`, "", `**Feature:** ${featureDescription}`, "", "## Slices", ""];
  for (const slice of slices) {
    lines.push(`- **${slice.description}** (\`${slice.implRelPath}\` / \`${slice.testRelPath}\`)`);
    lines.push(`  - GREEN: ${slice.greenGatePassed ? "passed" : "failed"}`);
    lines.push(`  - Refactored: ${slice.refactorApplied ? "yes" : "no"}`);
    lines.push(`  - Mutation score: ${(slice.mutationScore * 100).toFixed(0)}%`);
  }
  lines.push("");
  return lines.join("\n");
}

export async function writeback(opts: {
  targetDir: string;
  runId: string;
  featureDescription: string;
  slices: WritebackInputSlice[];
  commit: boolean;
}): Promise<WritebackResult> {
  const memoryDir = join(opts.targetDir, "memory");
  await mkdir(memoryDir, { recursive: true });
  const memoryFilePath = join(memoryDir, `${opts.runId}.md`);
  const markdown = buildMemoryMarkdown(opts.runId, opts.featureDescription, opts.slices);
  await writeFile(memoryFilePath, markdown);

  if (!opts.commit) {
    return { memoryFilePath, committed: false };
  }

  await runCommand("git", ["add", memoryFilePath], { cwd: opts.targetDir, timeoutMs: 15_000 });
  await runCommand("git", ["commit", "-q", "-m", `writeback: ${opts.runId}`], {
    cwd: opts.targetDir,
    timeoutMs: 30_000,
  });
  return { memoryFilePath, committed: true };
}
