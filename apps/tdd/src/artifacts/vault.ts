import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export function artifactPath(root: string, runId: string, name: string): string {
  return join(root, "artifacts", "tdd", runId, `${name}.json`);
}

export async function writeArtifact(
  root: string,
  runId: string,
  name: string,
  data: unknown,
): Promise<string> {
  const path = artifactPath(root, runId, name);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(data, null, 2));
  return path;
}

export async function readArtifact<T>(root: string, runId: string, name: string): Promise<T> {
  const path = artifactPath(root, runId, name);
  const raw = await readFile(path, "utf8");
  return JSON.parse(raw) as T;
}
