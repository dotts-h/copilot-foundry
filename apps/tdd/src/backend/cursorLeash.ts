import { mkdir, rm, rmdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
}

export async function writeLeashConfig(projectDir: string, lockedPaths: string[]): Promise<void> {
  const hooksDir = join(projectDir, ".cursor", "hooks");
  await mkdir(hooksDir, { recursive: true });

  const pattern = lockedPaths.map(escapeRegExp).join("|");
  const scriptPath = join(hooksDir, "deny-locked.sh");
  const script = `#!/usr/bin/env bash
input="$(cat)"
cmd="$(printf '%s' "$input" | jq -r '.command // empty' 2>/dev/null)"
if printf '%s' "$cmd" | grep -qE '${pattern}'; then
  jq -n '{permission:"deny", user_message:"path is leashed by helm-tdd"}'
else
  jq -n '{permission:"allow"}'
fi
`;
  await writeFile(scriptPath, script, { mode: 0o755 });

  const hooksJsonPath = join(projectDir, ".cursor", "hooks.json");
  const hooksJson = {
    version: 1,
    hooks: {
      beforeShellExecution: [{ command: scriptPath }],
    },
  };
  await writeFile(hooksJsonPath, JSON.stringify(hooksJson, null, 2));
}

export async function removeLeashConfig(projectDir: string): Promise<void> {
  const hooksDir = join(projectDir, ".cursor", "hooks");
  await unlink(join(hooksDir, "deny-locked.sh")).catch(() => {});
  await unlink(join(projectDir, ".cursor", "hooks.json")).catch(() => {});
  await rmdir(hooksDir).catch(() => {}); // only removes if empty — never clobber a real .cursor dir
  await rmdir(join(projectDir, ".cursor")).catch(() => {});
}
