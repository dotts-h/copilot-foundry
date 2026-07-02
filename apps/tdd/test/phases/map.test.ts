import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mapRepo } from "../../src/phases/map.js";
import { createPythonRunner } from "../../src/runner/pythonRunner.js";

const FIXTURE_VENV = join(process.cwd(), "fixtures", "add-kata", ".venv");
const runner = createPythonRunner(FIXTURE_VENV);

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

    const map = await mapRepo(dir);

    expect(map.files.sort()).toEqual(["strings_kata.py", "test_strings_kata.py"]);
    expect(map.testFiles).toEqual(["test_strings_kata.py"]);
    expect(map.imports["test_strings_kata.py"]).toContain("strings_kata");
    expect(map.imports["strings_kata.py"] ?? []).toEqual([]);
    expect(map.symbols).toEqual({});
  });

  it("returns empty collections for an empty repo", async () => {
    const map = await mapRepo(dir);
    expect(map.files).toEqual([]);
    expect(map.testFiles).toEqual([]);
    expect(map.imports).toEqual({});
    expect(map.symbols).toEqual({});
  });

  it("extracts function signatures, classes, and constants via the venv python", async () => {
    writeFileSync(
      join(dir, "sample.py"),
      [
        "MAX_ITEMS = 100",
        "DEFAULT_TIMEOUT = 30",
        "debug_mode = False",
        "",
        "def expected_session_fraction(now_utc: datetime, is_crypto: bool = False) -> float:",
        "    return 0.0",
        "",
        "async def fetch_data(url: str) -> dict:",
        "    return {}",
        "",
        "def with_kwonly(a, *, only_kw: int) -> None:",
        "    pass",
        "",
        "@staticmethod",
        "def decorated_fn(x: int) -> int:",
        "    return x",
        "",
        "class MyService:",
        "    def method_one(self, x: int) -> int:",
        "        return x",
        "",
        "    async def method_two(self) -> None:",
        "        pass",
        "",
      ].join("\n"),
    );

    const map = await mapRepo(dir, runner);
    const symbols = map.symbols["sample.py"];

    expect(symbols).toBeDefined();
    expect(symbols!.constants).toEqual(["MAX_ITEMS", "DEFAULT_TIMEOUT"]);
    expect(symbols!.functions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "expected_session_fraction",
          signature: "expected_session_fraction(now_utc: datetime, is_crypto: bool = False) -> float",
          line: 5,
        }),
        expect.objectContaining({
          name: "fetch_data",
          signature: "async fetch_data(url: str) -> dict",
        }),
        expect.objectContaining({
          name: "decorated_fn",
          signature: "decorated_fn(x: int) -> int",
        }),
      ]),
    );
    expect(symbols!.classes).toEqual([
      {
        name: "MyService",
        line: 18,
        methods: [
          {
            name: "method_one",
            signature: "method_one(self, x: int) -> int",
            line: 19,
          },
          {
            name: "method_two",
            signature: "async method_two(self) -> None",
            line: 22,
          },
        ],
      },
    ]);
  });

  it("marks syntax-error files as unparsed without failing the whole extraction", async () => {
    writeFileSync(join(dir, "good.py"), "def ok() -> int:\n    return 1\n");
    writeFileSync(join(dir, "bad.py"), "def broken(\n");

    const map = await mapRepo(dir, runner);

    expect(map.symbols["good.py"]).toEqual({
      functions: [{ name: "ok", signature: "ok() -> int", line: 1 }],
      classes: [],
      constants: [],
    });
    expect(map.symbols["bad.py"]).toEqual({
      functions: [],
      classes: [],
      constants: [],
      error: "unparsed",
    });
  });

  it("marks unreadable or non-utf8 files as unparsed without failing the whole extraction", async () => {
    writeFileSync(join(dir, "good.py"), "def ok() -> int:\n    return 1\n");
    writeFileSync(join(dir, "bad.py"), Buffer.from([0xff, 0xfe, 0xfd]));

    const map = await mapRepo(dir, runner);

    expect(map.symbols["good.py"]).toEqual({
      functions: [{ name: "ok", signature: "ok() -> int", line: 1 }],
      classes: [],
      constants: [],
    });
    expect(map.symbols["bad.py"]).toEqual({
      functions: [],
      classes: [],
      constants: [],
      error: "unparsed",
    });
  });

  it("returns empty symbols when venvDir is omitted", async () => {
    writeFileSync(join(dir, "sample.py"), "def foo() -> None:\n    pass\n");

    const map = await mapRepo(dir);

    expect(map.symbols).toEqual({});
    expect(map.files).toEqual(["sample.py"]);
    expect(map.testFiles).toEqual([]);
    expect(map.imports).toEqual({});
  });

  it("fail-soft returns empty symbols for a nonexistent venv", async () => {
    writeFileSync(join(dir, "sample.py"), "def foo() -> None:\n    pass\n");

    const map = await mapRepo(dir, createPythonRunner("/nonexistent-venv"));

    expect(map.symbols).toEqual({});
    expect(map.files).toEqual(["sample.py"]);
  });
});
