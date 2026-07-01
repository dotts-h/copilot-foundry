import { describe, expect, it } from "vitest";
import { evaluateLeash } from "../../src/backend/claudeLeash.js";

describe("evaluateLeash", () => {
  const cwd = "/work/repo";
  const locked = ["tests/test_add.py"];

  it("denies Write to a locked path given relative", () => {
    expect(evaluateLeash(cwd, locked, "Write", { file_path: "tests/test_add.py" }).deny).toBe(true);
  });
  it("denies Edit to a locked path given absolute", () => {
    expect(evaluateLeash(cwd, locked, "Edit", { file_path: "/work/repo/tests/test_add.py" }).deny).toBe(true);
  });
  it("denies NotebookEdit via notebook_path", () => {
    expect(evaluateLeash(cwd, ["nb.ipynb"], "NotebookEdit", { notebook_path: "/work/repo/nb.ipynb" }).deny).toBe(true);
  });
  it("allows Write to an unrelated path", () => {
    expect(evaluateLeash(cwd, locked, "Write", { file_path: "src/add.py" }).deny).toBe(false);
  });
  it("denies Bash commands that mention a locked path", () => {
    expect(evaluateLeash(cwd, locked, "Bash", { command: "echo x > tests/test_add.py" }).deny).toBe(true);
  });
  it("allows clean Bash commands", () => {
    expect(evaluateLeash(cwd, locked, "Bash", { command: "pytest -q" }).deny).toBe(false);
  });
  it("allows everything when nothing is locked", () => {
    expect(evaluateLeash(cwd, [], "Write", { file_path: "tests/test_add.py" }).deny).toBe(false);
  });
  it("always returns a reason on deny", () => {
    const d = evaluateLeash(cwd, locked, "Write", { file_path: "tests/test_add.py" });
    expect(d.reason).toContain("leash");
  });
});
