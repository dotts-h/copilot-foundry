import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createToolchain } from "../src/toolchain.js";

const FIXTURE_VENV = join(process.cwd(), "fixtures", "add-kata", ".venv");
const GO_FIXTURE = join(process.cwd(), "fixtures", "go-add-kata");

function copyGoFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "toolchain-go-"));
  cpSync(GO_FIXTURE, dir, { recursive: true });
  return dir;
}

describe("createToolchain (python)", () => {
  let dir: string;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("maps pytest exit code 0 to verdict passed", async () => {
    dir = mkdtempSync(join(tmpdir(), "toolchain-"));
    writeFileSync(join(dir, "test_ok.py"), "def test_ok():\n    assert True\n");
    const toolchain = await createToolchain("python", FIXTURE_VENV, dir);

    const result = await toolchain.runScoped(dir, "test_ok.py");

    expect(result.verdict).toBe("passed");
  });

  it("maps pytest exit code 1 to verdict tests_failed", async () => {
    dir = mkdtempSync(join(tmpdir(), "toolchain-"));
    writeFileSync(join(dir, "test_fail.py"), "def test_fail():\n    assert False\n");
    const toolchain = await createToolchain("python", FIXTURE_VENV, dir);

    const result = await toolchain.runScoped(dir, "test_fail.py");

    expect(result.verdict).toBe("tests_failed");
  });

  it("maps pytest exit code 5 (no tests collected) to verdict infra_error", async () => {
    dir = mkdtempSync(join(tmpdir(), "toolchain-"));
    const toolchain = await createToolchain("python", FIXTURE_VENV, dir);

    const result = await toolchain.runScoped(dir);

    expect(result.verdict).toBe("infra_error");
  });

  it("pathUnit is the identity function for python", async () => {
    dir = mkdtempSync(join(tmpdir(), "toolchain-"));
    const toolchain = await createToolchain("python", FIXTURE_VENV, dir);

    expect(toolchain.pathUnit("pkg/test_foo.py")).toBe("pkg/test_foo.py");
  });

  it("declares both the mutation gate and the refactor ratchet as supported", async () => {
    dir = mkdtempSync(join(tmpdir(), "toolchain-"));
    const toolchain = await createToolchain("python", FIXTURE_VENV, dir);

    expect(toolchain.supportsMutationGate).toBe(true);
    expect(toolchain.supportsRefactor).toBe(true);
  });
});

describe("createToolchain (go)", () => {
  let dir: string;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("throws a clear error when go.mod is missing", async () => {
    dir = mkdtempSync(join(tmpdir(), "toolchain-go-nomod-"));
    await expect(createToolchain("go", undefined, dir)).rejects.toThrow(/go\.mod/);
  });

  it("runVerbose on the kata (no test file) returns no tests", async () => {
    dir = copyGoFixture();
    const toolchain = await createToolchain("go", undefined, dir);

    const { tests } = await toolchain.runVerbose(dir);

    expect(tests).toEqual([]);
  });

  it("runScoped verdict is tests_failed once a real failing test is written", async () => {
    dir = copyGoFixture();
    writeFileSync(
      join(dir, "add_kata_test.go"),
      'package addkata\n\nimport "testing"\n\nfunc TestAdd(t *testing.T) {\n\tif got := Add(2, 3); got != 5 {\n\t\tt.Fatalf("got %d", got)\n\t}\n\tif got := Add(0, 0); got != 0 {\n\t\tt.Fatalf("got %d", got)\n\t}\n}\n',
    );
    const toolchain = await createToolchain("go", undefined, dir);

    const result = await toolchain.runScoped(dir, "add_kata_test.go");

    expect(result.verdict).toBe("tests_failed");
  });

  it("runScoped verdict is passed once Add is implemented correctly", async () => {
    dir = copyGoFixture();
    writeFileSync(
      join(dir, "add_kata_test.go"),
      'package addkata\n\nimport "testing"\n\nfunc TestAdd(t *testing.T) {\n\tif got := Add(2, 3); got != 5 {\n\t\tt.Fatalf("got %d", got)\n\t}\n\tif got := Add(0, 0); got != 0 {\n\t\tt.Fatalf("got %d", got)\n\t}\n}\n',
    );
    writeFileSync(join(dir, "add_kata.go"), "package addkata\n\nfunc Add(a, b int) int { return a + b }\n");
    const toolchain = await createToolchain("go", undefined, dir);

    const result = await toolchain.runScoped(dir, "add_kata_test.go");

    expect(result.verdict).toBe("passed");
  });

  it("pathUnit maps a root-level file to the module path", async () => {
    dir = copyGoFixture();
    const toolchain = await createToolchain("go", undefined, dir);

    expect(toolchain.pathUnit("add_kata.go")).toBe("go-add-kata");
  });

  it("declares neither the mutation gate nor the refactor ratchet as supported", async () => {
    dir = copyGoFixture();
    const toolchain = await createToolchain("go", undefined, dir);

    expect(toolchain.supportsMutationGate).toBe(false);
    expect(toolchain.supportsRefactor).toBe(false);
  });

  it("lintRedTest counts t.Errorf/t.Fatalf assertions", async () => {
    dir = copyGoFixture();
    const toolchain = await createToolchain("go", undefined, dir);

    const oneAssertion = toolchain.lintRedTest(
      'package addkata\n\nimport "testing"\n\nfunc TestAdd(t *testing.T) {\n\tif got := Add(2, 3); got != 5 {\n\t\tt.Fatalf("got %d", got)\n\t}\n}\n',
    );
    expect(oneAssertion.blocking).toEqual([]);
    expect(oneAssertion.warnings.some((w) => /triangulat/.test(w))).toBe(true);

    const twoAssertions = toolchain.lintRedTest(
      'package addkata\n\nimport "testing"\n\nfunc TestAdd(t *testing.T) {\n\tif got := Add(2, 3); got != 5 {\n\t\tt.Errorf("got %d", got)\n\t}\n\tif got := Add(0, 0); got != 0 {\n\t\tt.Errorf("got %d", got)\n\t}\n}\n',
    );
    expect(twoAssertions.warnings).toEqual([]);

    const noAssertions = toolchain.lintRedTest('package addkata\n\nfunc TestAdd() {}\n');
    expect(noAssertions.blocking).toContain("no t.Error/t.Fatal assertions found");
  });
});
