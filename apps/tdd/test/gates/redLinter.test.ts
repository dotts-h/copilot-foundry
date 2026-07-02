import { describe, expect, it } from "vitest";
import { lintGoRedTest, lintRedTest } from "../../src/gates/redLinter.js";

describe("lintRedTest", () => {
  it("blocks an empty test file", () => {
    const result = lintRedTest("");
    expect(result.blocking).toContain("test file is empty");
  });

  it("blocks a test file with no assert statements", () => {
    const result = lintRedTest("def test_nothing():\n    pass\n");
    expect(result.blocking).toContain("no assert statements found");
  });

  it("warns (does not block) on a single assertion, citing triangulation", () => {
    const result = lintRedTest("def test_add():\n    assert add(2, 3) == 5\n");
    expect(result.blocking).toEqual([]);
    expect(result.warnings.some((w) => /triangulat/.test(w))).toBe(true);
  });

  it("does not warn about triangulation when there are two or more assertions", () => {
    const result = lintRedTest(
      "def test_add():\n    assert add(2, 3) == 5\n    assert add(0, 0) == 0\n",
    );
    expect(result.warnings.some((w) => /triangulat/.test(w))).toBe(false);
  });

  it("warns on == True / == False literal comparisons", () => {
    const result = lintRedTest("def test_flag():\n    assert is_ok() == True\n    assert is_bad() == False\n");
    expect(result.warnings.some((w) => /True.*False/.test(w))).toBe(true);
  });

  it("flags a suite where every test asserts the same literal value (weak triangulation across the file)", () => {
    const result = lintRedTest(
      "def test_a():\n    assert add(2, 3) == 5\n\n\ndef test_b():\n    assert add(1, 4) == 5\n",
    );
    expect(result.warnings.some((w) => /same expected value/.test(w))).toBe(true);
  });

  it("does not flag suite-level weak-triangulation when assertions target different values", () => {
    const result = lintRedTest(
      "def test_a():\n    assert add(2, 3) == 5\n\n\ndef test_b():\n    assert add(1, 1) == 2\n",
    );
    expect(result.warnings.some((w) => /same expected value/.test(w))).toBe(false);
  });
});

describe("lintGoRedTest", () => {
  it("blocks an empty test file", () => {
    const result = lintGoRedTest("");
    expect(result.blocking).toContain("test file is empty");
  });

  it("blocks a test file with no t.Error/t.Fatal assertions", () => {
    const result = lintGoRedTest('package addkata\n\nimport "testing"\n\nfunc TestAdd(t *testing.T) {}\n');
    expect(result.blocking).toContain("no t.Error/t.Fatal assertions found");
  });

  it("warns (does not block) on a single assertion, citing triangulation", () => {
    const result = lintGoRedTest(
      'package addkata\n\nimport "testing"\n\nfunc TestAdd(t *testing.T) {\n\tif got := Add(2, 3); got != 5 {\n\t\tt.Fatalf("got %d", got)\n\t}\n}\n',
    );
    expect(result.blocking).toEqual([]);
    expect(result.warnings.some((w) => /triangulat/.test(w))).toBe(true);
  });

  it("does not warn about triangulation when there are two or more assertions", () => {
    const result = lintGoRedTest(
      'package addkata\n\nimport "testing"\n\nfunc TestAdd(t *testing.T) {\n\tif got := Add(2, 3); got != 5 {\n\t\tt.Errorf("got %d", got)\n\t}\n\tif got := Add(0, 0); got != 0 {\n\t\tt.Errorf("got %d", got)\n\t}\n}\n',
    );
    expect(result.warnings).toEqual([]);
  });
});
