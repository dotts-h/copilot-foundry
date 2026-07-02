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

  it("finds go files, classifies test files, extracts imports (single and block form), and reads modulePath", async () => {
    writeFileSync(join(dir, "go.mod"), "module go-add-kata\n\ngo 1.22\n");
    writeFileSync(join(dir, "add_kata.go"), "package addkata\n\nfunc Add(a, b int) int { return a + b }\n");
    writeFileSync(
      join(dir, "add_kata_test.go"),
      'package addkata\n\nimport "testing"\n\nfunc TestAdd(t *testing.T) {\n\tif got := Add(2, 3); got != 5 {\n\t\tt.Fatalf("got %d", got)\n\t}\n}\n',
    );
    mkdirSync(join(dir, "internal", "util"), { recursive: true });
    writeFileSync(
      join(dir, "internal", "util", "helper.go"),
      'package util\n\nimport (\n\t"fmt"\n\tmylog "log"\n)\n\nfunc Log() {\n\tfmt.Println("x")\n\tmylog.Println("y")\n}\n',
    );
    mkdirSync(join(dir, "vendor", "example.com", "dep"), { recursive: true });
    writeFileSync(
      join(dir, "vendor", "example.com", "dep", "dep.go"),
      "package dep\n\nfunc ShouldNeverBeScanned() {}\n",
    );
    mkdirSync(join(dir, "testdata"), { recursive: true });
    writeFileSync(join(dir, "testdata", "fixture.go"), "package testdata\n\nfunc ShouldNeverBeScanned() {}\n");

    const map = await mapRepo(dir, "go");

    expect(map.files.sort()).toEqual(["add_kata.go", "add_kata_test.go", "internal/util/helper.go"]);
    expect(map.testFiles).toEqual(["add_kata_test.go"]);
    expect(map.imports["add_kata_test.go"]).toEqual(["testing"]);
    expect(map.imports["internal/util/helper.go"]?.sort()).toEqual(["fmt", "log"]);
    expect(map.modulePath).toBe("go-add-kata");
  });
});
