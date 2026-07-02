import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createToolchain } from "../src/toolchain.js";

const FIXTURE_VENV = join(process.cwd(), "fixtures", "add-kata", ".venv");

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
  it("throws until go support lands in task 4", async () => {
    const dir = mkdtempSync(join(tmpdir(), "toolchain-go-"));
    try {
      await expect(createToolchain("go", undefined, dir)).rejects.toThrow(/not implemented until task 4/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
