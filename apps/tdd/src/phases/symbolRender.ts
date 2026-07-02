import type { FileSymbols, RepoMap } from "./map.js";

export const PLAN_SYMBOLS_CAP = 8000;
export const SLICE_SYMBOLS_CAP = 2000;

export function renderFileSymbols(relPath: string, symbols: FileSymbols): string {
  if (symbols.error) {
    return `${relPath}: (unparsed)`;
  }

  const lines: string[] = [`${relPath}:`];
  for (const fn of symbols.functions) {
    lines.push(`  ${fn.signature}`);
  }
  for (const cls of symbols.classes) {
    const methodNames = cls.methods.map((m) => m.name);
    const methodsPart = methodNames.length > 0 ? methodNames.join(", ") : "—";
    lines.push(`  class ${cls.name} (methods: ${methodsPart})`);
  }
  if (symbols.constants.length > 0) {
    lines.push(`  constants: ${symbols.constants.join(", ")}`);
  }
  return lines.join("\n");
}

export function renderSymbols(map: RepoMap, files: string[], capChars: number): string {
  const blocks: string[] = [];
  let totalLen = 0;
  let truncatedCount = 0;

  for (let i = 0; i < files.length; i++) {
    const relPath = files[i];
    const symbols = map.symbols[relPath];
    if (!symbols) continue;

    const block = renderFileSymbols(relPath, symbols);
    const separator = blocks.length > 0 ? "\n" : "";
    const addition = separator + block;

    if (totalLen + addition.length > capChars) {
      for (let j = i; j < files.length; j++) {
        if (map.symbols[files[j]]) truncatedCount++;
      }
      break;
    }

    totalLen += addition.length;
    blocks.push(block);
  }

  if (blocks.length === 0) return "";

  let result = blocks.join("\n");
  if (truncatedCount > 0) {
    result += `\n... (symbols truncated: ${truncatedCount} more files)`;
  }
  return result;
}
