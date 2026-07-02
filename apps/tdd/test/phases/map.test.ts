import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mapRepo } from "../../src/phases/map.js";

describe("mapRepo", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "map-repo-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("finds python files, classifies test files, and extracts imports", async () => {
    writeFileSync(join(dir, "strings_kata.py"), "def reverse_words(s):\n    raise NotImplementedError\n");
    writeFileSync(
      join(dir, "test_strings_kata.py"),
      "from strings_kata import reverse_words\n\ndef test_reverse_words():\n    assert reverse_words('a b') == 'b a'\n",
    );
    mkdirSync(join(dir, ".venv", "lib"), { recursive: true });
    writeFileSync(join(dir, ".venv", "lib", "ignored.py"), "raise RuntimeError('should never be scanned')");
    mkdirSync(join(dir, "__pycache__"), { recursive: true });
    writeFileSync(join(dir, "__pycache__", "ignored2.py"), "raise RuntimeError('should never be scanned')");

    const map = await mapRepo(dir, "python");

    expect(map.files.sort()).toEqual(["strings_kata.py", "test_strings_kata.py"]);
    expect(map.testFiles).toEqual(["test_strings_kata.py"]);
    expect(map.imports["test_strings_kata.py"]).toContain("strings_kata");
    expect(map.imports["strings_kata.py"] ?? []).toEqual([]);
  });

  it("returns empty collections for an empty repo", async () => {
    const map = await mapRepo(dir, "python");
    expect(map.files).toEqual([]);
    expect(map.testFiles).toEqual([]);
    expect(map.imports).toEqual({});
  });
});
