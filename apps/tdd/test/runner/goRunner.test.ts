import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { computeGoMutationScore, goMutationDeps, runGoMutator } from "../../src/runner/goMutation.js";
import {
  classifyGoRun,
  createGoRunner,
  goRunnerDeps,
  GO_RED_PROMPT_RULES,
  isMissingSymbolError,
  packageOf,
  parseGoTestVerboseOutput,
  parseModulePath,
  pkgRelDirFromImportPath,
  testPathKeyFromRelPath,
} from "../../src/runner/goRunner.js";
import { extractGoSymbols } from "../../src/runner/goSymbols.js";

const MODULE_PATH = "example.com/foo";

const VERBOSE_FIXTURE = [
  "=== RUN   TestPkgPass",
  "--- PASS: TestPkgPass (0.00s)",
  "=== RUN   TestPkgFail",
  "--- FAIL: TestPkgFail (0.00s)",
  "=== RUN   TestPkgSkip",
  "--- SKIP: TestPkgSkip (0.00s)",
  "=== RUN   TestSub",
  "=== RUN   TestSub/case",
  "--- PASS: TestSub/case (0.00s)",
  "--- PASS: TestSub (0.00s)",
  "FAIL",
  `FAIL\t${MODULE_PATH}/pkg\t0.001s`,
  `FAIL\t${MODULE_PATH}/broken [build failed]`,
  "=== RUN   TestRoot",
  "--- PASS: TestRoot (0.00s)",
  `ok  \t${MODULE_PATH}\t0.001s`,
].join("\n");

function hasGo(): boolean {
  try {
    execSync("go version", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const goAvailable = hasGo();

describe("packageOf", () => {
  it("maps root files to ./ and nested files to ./dir", () => {
    expect(packageOf("foo.go")).toBe("./");
    expect(packageOf("foo_test.go")).toBe("./");
    expect(packageOf("pkg/math.go")).toBe("./pkg");
    expect(packageOf("pkg/sub/math.go")).toBe("./pkg/sub");
  });
});

describe("testPathKeyFromRelPath", () => {
  it("returns . for root files and dirname for nested paths", () => {
    expect(testPathKeyFromRelPath("foo_test.go")).toBe(".");
    expect(testPathKeyFromRelPath("pkg/foo_test.go")).toBe("pkg");
    expect(testPathKeyFromRelPath("pkg/sub/foo_test.go")).toBe("pkg/sub");
  });
});

describe("parseGoTestVerboseOutput consistency with testPathKey", () => {
  it("uses the same package-relative dirs as testPathKey for a shared fixture", () => {
    const tests = parseGoTestVerboseOutput(VERBOSE_FIXTURE, MODULE_PATH);
    expect(tests).toEqual([
      { nodeId: "pkg::TestPkgPass", outcome: "passed" },
      { nodeId: "pkg::TestPkgFail", outcome: "failed" },
      { nodeId: "pkg::TestPkgSkip", outcome: "skipped" },
      { nodeId: "pkg::TestSub/case", outcome: "passed" },
      { nodeId: "pkg::TestSub", outcome: "passed" },
      { nodeId: ".::TestRoot", outcome: "passed" },
    ]);

    expect(testPathKeyFromRelPath("pkg/foo_test.go")).toBe("pkg");
    expect(testPathKeyFromRelPath("foo_test.go")).toBe(".");
    expect(tests.some((t) => t.nodeId.startsWith(`${testPathKeyFromRelPath("pkg/foo_test.go")}::`))).toBe(true);
    expect(tests.some((t) => t.nodeId.startsWith(`${testPathKeyFromRelPath("foo_test.go")}::`))).toBe(true);
  });

  it("strips the module path including root package", () => {
    expect(pkgRelDirFromImportPath(MODULE_PATH, MODULE_PATH)).toBe(".");
    expect(pkgRelDirFromImportPath(`${MODULE_PATH}/pkg`, MODULE_PATH)).toBe("pkg");
    expect(parseModulePath(`module ${MODULE_PATH}\n\ngo 1.22\n`)).toBe(MODULE_PATH);
  });
});

describe("classifyGoRun", () => {
  it("maps build failures to harness_error and plain failures to failed", () => {
    expect(classifyGoRun({ exitCode: 0, raw: "" })).toBe("passed");
    expect(classifyGoRun({ exitCode: 1, raw: "FAIL\n--- FAIL: TestX" })).toBe("failed");
    expect(classifyGoRun({ exitCode: 1, raw: "FAIL\texample.com/foo [build failed]" })).toBe("harness_error");
    expect(classifyGoRun({ exitCode: 1, raw: "FAIL\texample.com/foo [setup failed]" })).toBe("harness_error");
    expect(classifyGoRun({ exitCode: 1, raw: "# example.com/foo\n./foo.go:1:1: undefined: Bar" })).toBe(
      "harness_error",
    );
    expect(classifyGoRun({ exitCode: 2, raw: "" })).toBe("harness_error");
  });
});

describe("isMissingSymbolError", () => {
  const name = "Foo";

  it.each([
    "undefined: Foo",
    "undefined: pkg.Foo",
    "Foo not declared by package",
    "x has no field or method Foo",
  ])("matches %j", (raw) => {
    expect(isMissingSymbolError(raw, name)).toBe(true);
  });

  it("does not match a different symbol name", () => {
    expect(isMissingSymbolError("undefined: Bar", name)).toBe(false);
  });
});

describe("isMissingSymbolError generic missing-symbol diagnostics (not pinned to functionName)", () => {
  // Tradeoff accepted here: once we fall back to broad, ANY-identifier patterns, a
  // typo'd identifier in the RED test (e.g. referencing "Contrl" instead of "Control")
  // would also be classified as missing_symbol instead of collection_error. That is
  // considered acceptable because the orchestrator's branch review is the backstop
  // that catches a RED test asserting against the wrong symbol.
  it("accepts generic Go compiler missing-symbol shapes even when unrelated to functionName, but still rejects plain syntax errors", async () => {
    const { isMissingSymbolError: isMissingSymbolErrorDynamic } = await import("../../src/runner/goRunner.js");

    // (1) verbatim twiceshy failure line: a brand-new struct field reference on an
    // existing type, with functionName pinned to something else entirely.
    expect(
      isMissingSymbolErrorDynamic(
        "internal/agenteval/model_task_drafter_test.go:131:8: dt.Control undefined " +
          "(type draftedTaskJSON has no field or method Control)",
        "parseDraftedTask",
      ),
    ).toBe(true);

    // (2) "unknown field X in struct literal" shape, also unrelated to functionName.
    expect(
      isMissingSymbolErrorDynamic(
        "internal/agenteval/model_task_drafter_test.go:140:9: unknown field Verdict " +
          "in struct literal of type draftedTaskJSON",
        "parseDraftedTask",
      ),
    ).toBe(true);

    // (3) a pure Go syntax error must still be rejected so collection_error remains
    // reachable for malformed tests -- not every compile failure is a missing symbol.
    expect(
      isMissingSymbolErrorDynamic(
        "internal/agenteval/model_task_drafter_test.go:12:5: syntax error: expected ';', found 'EOF'",
        "parseDraftedTask",
      ),
    ).toBe(false);
  });
});

describe("isMissingSymbolError accepts Go signature-change compiler diagnostics", () => {
  it("treats assignment-mismatch, argument-count, and return-value-count diagnostics as missing-symbol evidence, but still rejects plain syntax errors", async () => {
    const { isMissingSymbolError: isMissingSymbolErrorDynamic } = await import("../../src/runner/goRunner.js");

    // (1) assignment mismatch, plural "variables" shape -- a caller written against the
    // OLD signature (e.g. `x, err := ParseThing()`) while the new RED test drives a
    // signature that now returns more values than are assigned.
    expect(
      isMissingSymbolErrorDynamic(
        "internal/foo/foo_test.go:22:10: assignment mismatch: 2 variables but 1 value",
        "ParseThing",
      ),
    ).toBe(true);

    // (2) assignment mismatch, singular "variable" shape -- Go's compiler pluralizes
    // "variable"/"value" independently, so both forms must be recognized.
    expect(
      isMissingSymbolErrorDynamic(
        "internal/foo/foo_test.go:23:2: assignment mismatch: 1 variable but 2 values",
        "ParseThing",
      ),
    ).toBe(true);

    // (3) not enough arguments in call to <expr>.
    expect(
      isMissingSymbolErrorDynamic(
        "internal/foo/foo_test.go:24:5: not enough arguments in call to ParseThing\n\thave (int)\n\twant (int, string)",
        "ParseThing",
      ),
    ).toBe(true);

    // (4) too many arguments in call to <expr>.
    expect(
      isMissingSymbolErrorDynamic(
        "internal/foo/foo_test.go:25:5: too many arguments in call to ParseThing\n\thave (int, string, bool)\n\twant (int, string)",
        "ParseThing",
      ),
    ).toBe(true);

    // (4b) verbatim twiceshy run-6e871752 failure line: the call-RHS shape
    // ("but <expr> returns N values") a changed return arity actually produces,
    // with a functionName unrelated to the diagnostic.
    expect(
      isMissingSymbolErrorDynamic(
        "internal/index/idf_gate_internal_test.go:131:24: assignment mismatch: 3 variables but ix.discriminativeTokensVia returns 2 values",
        "discriminativeTokensVia",
      ),
    ).toBe(true);

    // (5) not enough return values.
    expect(
      isMissingSymbolErrorDynamic(
        "internal/foo/foo_test.go:30:2: not enough return values\n\thave (int)\n\twant (int, error)",
        "ParseThing",
      ),
    ).toBe(true);

    // (6) too many return values.
    expect(
      isMissingSymbolErrorDynamic(
        "internal/foo/foo_test.go:31:2: too many return values\n\thave (int, error, bool)\n\twant (int, error)",
        "ParseThing",
      ),
    ).toBe(true);

    // (7) a pure Go syntax error must still be rejected so collection_error remains
    // reachable for malformed tests -- not every compile failure is a signature change.
    expect(
      isMissingSymbolErrorDynamic(
        "internal/foo/foo_test.go:12:5: syntax error: unexpected newline, expecting comma or )",
        "ParseThing",
      ),
    ).toBe(false);
  });
});

describe("GO_MISSING_SYMBOL_RED_NOTE mentions the assignment-mismatch shape", () => {
  it("adds the assignment-mismatch diagnostic to its parenthetical example list alongside the existing examples", async () => {
    const { GO_MISSING_SYMBOL_RED_NOTE: note } = await import("../../src/runner/goRunner.js");

    expect(note).toContain("undefined: <symbol>");
    expect(note).toMatch(/assignment mismatch/);
  });
});

describe("createGoRunner command construction", () => {
  let dir: string;
  let runSpy: ReturnType<typeof vi.spyOn>;

  afterEach(() => {
    runSpy.mockRestore();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  beforeEach(() => {
    runSpy = vi.spyOn(goRunnerDeps, "runCommand").mockResolvedValue({
      exitCode: 0,
      stdout: "",
      stderr: "",
    });
  });

  it("builds scoped go test argv with GOFLAGS and package paths", async () => {
    dir = mkdtempSync(join(tmpdir(), "go-runner-"));
    writeFileSync(join(dir, "go.mod"), `module ${MODULE_PATH}\n`);
    const runner = createGoRunner(dir);

    await runner.runTests(dir, "pkg/math_test.go");
    expect(runSpy).toHaveBeenCalledWith(
      "go",
      ["test", "./pkg"],
      expect.objectContaining({ cwd: dir, env: { GOFLAGS: "-count=1" }, timeoutMs: 180_000 }),
    );

    await runner.runTests(dir);
    expect(runSpy).toHaveBeenCalledWith(
      "go",
      ["test", "./..."],
      expect.objectContaining({ cwd: dir, env: { GOFLAGS: "-count=1" } }),
    );
  });

  it("dedupes packages for runTestsOnPaths and uses ./... when empty", async () => {
    dir = mkdtempSync(join(tmpdir(), "go-runner-"));
    const runner = createGoRunner(dir);

    await runner.runTestsOnPaths(dir, ["pkg/a_test.go", "pkg/b_test.go", "other/x_test.go"]);
    expect(runSpy).toHaveBeenCalledWith(
      "go",
      ["test", "./pkg", "./other"],
      expect.objectContaining({ cwd: dir }),
    );

    runSpy.mockClear();
    await runner.runTestsOnPaths(dir, []);
    expect(runSpy).toHaveBeenCalledWith("go", ["test", "./..."], expect.objectContaining({ cwd: dir }));
  });

  it("builds verbose and go vet argv", async () => {
    dir = mkdtempSync(join(tmpdir(), "go-runner-"));
    writeFileSync(join(dir, "go.mod"), `module ${MODULE_PATH}\n`);
    const runner = createGoRunner(dir);

    await runner.runTestsVerbose(dir);
    expect(runSpy).toHaveBeenCalledWith(
      "go",
      ["test", "./...", "-v"],
      expect.objectContaining({ cwd: dir, env: { GOFLAGS: "-count=1" } }),
    );

    runSpy.mockClear();
    await runner.runStaticGates(dir);
    expect(runSpy).toHaveBeenCalledWith(
      "go",
      ["vet", "./..."],
      expect.objectContaining({ cwd: dir, timeoutMs: 120_000 }),
    );
  });

  it("uses the go red prompt rule text", () => {
    const runner = createGoRunner("/tmp");
    expect(runner.redPromptRules).toBe(GO_RED_PROMPT_RULES);
    expect(runner.language).toBe("go");
    expect(runner.testFrameworkName).toBe("go test");
  });
});

describe("createGoRunner predicates", () => {
  const runner = createGoRunner("/tmp");

  it("identifies source and test files", () => {
    expect(runner.isSourceFile("math.go")).toBe(true);
    expect(runner.isSourceFile("math_test.go")).toBe(true);
    expect(runner.isSourceFile("vendor/math.go")).toBe(false);
    expect(runner.isSourceFile("pkg/testdata/math.go")).toBe(false);
    expect(runner.isTestFile("math_test.go")).toBe(true);
    expect(runner.isTestFile("math.go")).toBe(false);
  });

  it("testPathKey matches testPathKeyFromRelPath", () => {
    expect(runner.testPathKey("pkg/foo_test.go")).toBe("pkg");
    expect(runner.testPathKey("foo_test.go")).toBe(".");
  });
});

describe("createGoRunner lintRedTest", () => {
  const runner = createGoRunner("/tmp");

  it("does not warn on a table-driven test with range and a single t.Errorf", () => {
    const result = runner.lintRedTest(
      "func TestAdd(t *testing.T) {\n" +
        "  for _, tc := range []struct{ a, b, want int }{{1, 2, 3}} {\n" +
        "    if got := Add(tc.a, tc.b); got != tc.want {\n" +
        "      t.Errorf(\"got %d want %d\", got, tc.want)\n" +
        "    }\n" +
        "  }\n" +
        "}\n",
    );
    expect(result.blocking).toEqual([]);
    expect(result.warnings.some((w) => /triangulat/.test(w))).toBe(false);
  });

  it("blocks a test file with no t.* or testify assertions", () => {
    const result = runner.lintRedTest("func TestAdd(t *testing.T) {\n  _ = Add(1, 2)\n}\n");
    expect(result.blocking.some((b) => /no assertions found/.test(b))).toBe(true);
  });
});

describe("computeGoMutationScore TS flow", () => {
  let dir: string;
  let mutatorSpy: ReturnType<typeof vi.spyOn>;
  let extractSpy: ReturnType<typeof vi.spyOn>;

  afterEach(() => {
    mutatorSpy?.mockRestore();
    extractSpy?.mockRestore();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  function mockConstantNotApplicable(): void {
    extractSpy = vi.spyOn(goMutationDeps, "runGoExtractExpected").mockResolvedValue({ found: false });
  }

  it("reports outcome:not_applicable when the operator does not apply", async () => {
    dir = mkdtempSync(join(tmpdir(), "go-mutation-"));
    writeFileSync(join(dir, "math.go"), "package math\n\nfunc Add(a, b int) int {\n\treturn a + b\n}\n");
    mockConstantNotApplicable();
    mutatorSpy = vi.spyOn(goMutationDeps, "runGoMutator").mockResolvedValue({
      applicable: false,
    });
    const runTestsFocused = vi.fn().mockResolvedValue({ exitCode: 1, raw: "failed" });

    const score = await computeGoMutationScore(runTestsFocused, {
      workDir: dir,
      implRelPath: "math.go",
      functionName: "Add",
      testRelPath: "math_test.go",
    }, classifyGoRun, join(dir, "math_test.go"));

    const comparison = score.results.find((r) => r.operator === "comparison-swap");
    expect(comparison).toEqual({ operator: "comparison-swap", outcome: "not_applicable", survived: null });
    expect(runTestsFocused).not.toHaveBeenCalled();
  });

  it("restores the original file even when runTestsFocused throws", async () => {
    dir = mkdtempSync(join(tmpdir(), "go-mutation-"));
    const source = "package math\n\nfunc Add(a, b int) int {\n\treturn a + b\n}\n";
    writeFileSync(join(dir, "math.go"), source);
    mockConstantNotApplicable();
    mutatorSpy = vi.spyOn(goMutationDeps, "runGoMutator").mockImplementation(
      async (_implPath, _name, operator) =>
        operator === "arithmetic-swap"
          ? { applicable: true, mutatedSource: "package math\n\nfunc Add(a, b int) int {\n\treturn a - b\n}\n" }
          : { applicable: false },
    );
    const runTestsFocused = vi.fn().mockRejectedValue(new Error("boom"));

    await expect(
      computeGoMutationScore(runTestsFocused, {
        workDir: dir,
        implRelPath: "math.go",
        functionName: "Add",
        testRelPath: "math_test.go",
      }, classifyGoRun, join(dir, "math_test.go")),
    ).rejects.toThrow("boom");

    expect(readFileSync(join(dir, "math.go"), "utf8")).toBe(source);
  });

  it("treats harness_error focused runs as outcome:not_applicable", async () => {
    dir = mkdtempSync(join(tmpdir(), "go-mutation-"));
    writeFileSync(join(dir, "math.go"), "package math\n\nfunc Add(a, b int) int {\n\treturn a + b\n}\n");
    mockConstantNotApplicable();
    mutatorSpy = vi.spyOn(goMutationDeps, "runGoMutator").mockImplementation(
      async (_implPath, _name, operator) =>
        operator === "arithmetic-swap"
          ? { applicable: true, mutatedSource: "package math\n\nfunc Add(a, b int) int {\n\treturn a - b\n}\n" }
          : { applicable: false },
    );
    const runTestsFocused = vi.fn().mockResolvedValue({
      exitCode: 1,
      raw: "# example.com/math\n./math.go:1:1: syntax error",
    });

    const score = await computeGoMutationScore(runTestsFocused, {
      workDir: dir,
      implRelPath: "math.go",
      functionName: "Add",
      testRelPath: "math_test.go",
    }, classifyGoRun, join(dir, "math_test.go"));

    const arithmetic = score.results.find((r) => r.operator === "arithmetic-swap");
    expect(arithmetic).toEqual({ operator: "arithmetic-swap", outcome: "not_applicable", survived: null });
  });

  it("computes score from killed mutants with stubbed focused runs", async () => {
    dir = mkdtempSync(join(tmpdir(), "go-mutation-"));
    writeFileSync(join(dir, "math.go"), "package math\n\nfunc Add(a, b int) int {\n\treturn a + b\n}\n");
    mockConstantNotApplicable();
    mutatorSpy = vi.spyOn(goMutationDeps, "runGoMutator").mockImplementation(
      async (_implPath, _name, operator) =>
        operator === "arithmetic-swap"
          ? { applicable: true, mutatedSource: "package math\n\nfunc Add(a, b int) int {\n\treturn a - b\n}\n" }
          : { applicable: false },
    );
    const runTestsFocused = vi.fn().mockResolvedValue({ exitCode: 1, raw: "FAIL" });

    const score = await computeGoMutationScore(runTestsFocused, {
      workDir: dir,
      implRelPath: "math.go",
      functionName: "Add",
      testRelPath: "math_test.go",
    }, classifyGoRun, join(dir, "math_test.go"));

    const arithmetic = score.results.find((r) => r.operator === "arithmetic-swap");
    expect(arithmetic?.outcome).toBe("applied");
    expect(arithmetic?.survived).toBe(false);
    expect(score.attemptedCount).toBeGreaterThan(0);
    expect(score.score).toBeGreaterThan(0);
  });
});

describe.skipIf(!goAvailable)("live Go toolchain", () => {
  let dir: string;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  function seedSymbolFixture(): void {
    dir = mkdtempSync(join(tmpdir(), "go-symbols-"));
    writeFileSync(join(dir, "go.mod"), "module example.com/sample\n\ngo 1.22\n");
    writeFileSync(
      join(dir, "sample.go"),
      [
        "package sample",
        "",
        "const Pi = 3",
        "",
        "func Add(a int, b string) (int, error) {",
        "\treturn 0, nil",
        "}",
        "",
        "type Service struct{}",
        "",
        "func (s *Service) Run(x int) bool {",
        "\treturn x > 0",
        "}",
        "",
        "type Reader interface {",
        "\tRead() error",
        "}",
      ].join("\n"),
    );
    writeFileSync(join(dir, "broken.go"), "package sample\n\nfunc {{{\n");
  }

  it("extractSymbols against fixture sources", async () => {
    seedSymbolFixture();
    const symbols = await extractGoSymbols(dir, ["sample.go", "broken.go"]);

    expect(symbols["sample.go"].functions).toEqual([
      { name: "Add", signature: "func Add(a int, b string) (int, error)", line: 5 },
    ]);
    expect(symbols["sample.go"].classes[0].name).toBe("Service");
    expect(symbols["sample.go"].classes[0].methods.map((m) => m.name)).toEqual(["Run"]);
    expect(symbols["sample.go"].classes.some((c) => c.name === "Reader")).toBe(true);
    expect(symbols["sample.go"].constants).toEqual(["Pi"]);
    expect(symbols["broken.go"]).toEqual({
      functions: [],
      classes: [],
      constants: [],
      error: "unparsed",
    });
  });

  it("mutator script applies each operator and reports applicable:false when none apply", async () => {
    dir = mkdtempSync(join(tmpdir(), "go-mutator-"));
    mkdirSync(join(dir, "pkg"), { recursive: true });
    writeFileSync(join(dir, "go.mod"), "module example.com/mut\n\ngo 1.22\n");
    writeFileSync(
      join(dir, "pkg", "math.go"),
      [
        "package pkg",
        "",
        "func Add(a, b int) int {",
        "\treturn a + b",
        "}",
        "",
        "func IsPos(x int) bool {",
        "\treturn x > 0",
        "}",
        "",
        "func Ok() bool {",
        "\treturn true",
        "}",
        "",
        "func Constant() int {",
        "\treturn 1",
        "}",
      ].join("\n"),
    );

    const implPath = join(dir, "pkg", "math.go");
    const arithmetic = await runGoMutator(implPath, "Add", "arithmetic-swap");
    expect(arithmetic.applicable).toBe(true);
    expect(arithmetic.mutatedSource).toContain("a - b");

    const comparison = await runGoMutator(implPath, "IsPos", "comparison-swap");
    expect(comparison.applicable).toBe(true);
    expect(comparison.mutatedSource).toMatch(/<=/);

    const boolean = await runGoMutator(implPath, "Ok", "boolean-negation");
    expect(boolean.applicable).toBe(true);
    expect(boolean.mutatedSource).toMatch(/return false/);

    const none = await runGoMutator(implPath, "Constant", "comparison-swap");
    expect(none).toEqual({ applicable: false });
  });
});
