import { describe, expect, it } from "vitest";
import type { FileSymbols, RepoMap } from "../../src/phases/map.js";
import { renderFileSymbols, renderSymbols } from "../../src/phases/symbolRender.js";

const FULL_SYMBOLS: FileSymbols = {
  functions: [
    {
      name: "expected_session_fraction",
      signature: "expected_session_fraction(now_utc: datetime, is_crypto: bool) -> float",
      line: 1,
    },
    {
      name: "detect_triggers",
      signature:
        "detect_triggers(symbol: str, quote: LiveQuote, state: WatchdogState, now_utc: datetime, *, cooldown: timedelta = DEFAULT_COOLDOWN) -> list[Fact]",
      line: 5,
    },
  ],
  classes: [
    {
      name: "WatchdogState",
      line: 10,
      methods: [],
    },
    {
      name: "ActiveService",
      line: 15,
      methods: [
        { name: "start", signature: "start(self) -> None", line: 16 },
        { name: "stop", signature: "stop(self) -> None", line: 19 },
      ],
    },
  ],
  constants: ["EQUITY_PCT_THRESHOLD", "CRYPTO_PCT_THRESHOLD", "VOLUME_SPIKE_MULTIPLE"],
};

describe("renderFileSymbols", () => {
  it("renders functions, classes with/without methods, and constants", () => {
    const rendered = renderFileSymbols("src/marketdesk/watchdog.py", FULL_SYMBOLS);

    expect(rendered).toContain("src/marketdesk/watchdog.py:");
    expect(rendered).toContain("  expected_session_fraction(now_utc: datetime, is_crypto: bool) -> float");
    expect(rendered).toContain(
      "  detect_triggers(symbol: str, quote: LiveQuote, state: WatchdogState, now_utc: datetime, *, cooldown: timedelta = DEFAULT_COOLDOWN) -> list[Fact]",
    );
    expect(rendered).toContain("  class WatchdogState (methods: —)");
    expect(rendered).toContain("  class ActiveService (methods: start, stop)");
    expect(rendered).toContain(
      "  constants: EQUITY_PCT_THRESHOLD, CRYPTO_PCT_THRESHOLD, VOLUME_SPIKE_MULTIPLE",
    );
  });

  it("renders unparsed files as a single-line marker", () => {
    expect(renderFileSymbols("broken.py", { functions: [], classes: [], constants: [], error: "unparsed" })).toBe(
      "broken.py: (unparsed)",
    );
  });
});

describe("renderSymbols", () => {
  const map: RepoMap = {
    files: ["a.py", "b.py", "c.py"],
    testFiles: [],
    imports: {},
    symbols: {
      "a.py": {
        functions: [{ name: "foo", signature: "foo() -> int", line: 1 }],
        classes: [],
        constants: [],
      },
      "b.py": {
        functions: [{ name: "bar", signature: "bar(x: str) -> None", line: 1 }],
        classes: [],
        constants: [],
      },
    },
  };

  it("returns empty string when no symbol entries match", () => {
    expect(renderSymbols(map, ["missing.py"], 1000)).toBe("");
    expect(renderSymbols({ ...map, symbols: {} }, ["a.py"], 1000)).toBe("");
  });

  it("skips files with no symbol entry and preserves order", () => {
    const rendered = renderSymbols(map, ["missing.py", "a.py", "b.py"], 1000);
    expect(rendered.indexOf("a.py:")).toBeLessThan(rendered.indexOf("b.py:"));
    expect(rendered).not.toContain("missing.py");
  });

  it("truncates when the next whole file block would exceed the cap", () => {
    const blockA = renderFileSymbols("a.py", map.symbols["a.py"]!);
    const cap = blockA.length + 1;

    const rendered = renderSymbols(map, ["a.py", "b.py"], cap);

    expect(rendered).toContain("a.py:");
    expect(rendered).not.toContain("b.py:");
    expect(rendered).toContain("... (symbols truncated: 1 more files)");
  });
});
