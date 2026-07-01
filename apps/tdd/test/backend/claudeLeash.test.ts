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
  it("allows Read of a locked path (the leash is a write leash)", () => {
    expect(evaluateLeash(cwd, locked, "Read", { file_path: "tests/test_add.py" }).deny).toBe(false);
  });
  it("allows Bash naming a file that merely embeds a locked filename", () => {
    expect(evaluateLeash(cwd, ["add_kata.py"], "Bash", { command: "pytest test_add_kata.py" }).deny).toBe(false);
  });
  it("still denies Bash referencing the locked path as its own token", () => {
    expect(evaluateLeash(cwd, ["add_kata.py"], "Bash", { command: "pytest add_kata.py" }).deny).toBe(true);
  });
  it("denies Write to an absolute path outside the workspace", () => {
    const d = evaluateLeash(cwd, locked, "Write", { file_path: "/home/somewhere/else.py" });
    expect(d.deny).toBe(true);
    expect(d.reason).toContain("outside the helm-tdd workspace");
  });
  it("denies Edit escaping the workspace via ..", () => {
    expect(evaluateLeash(cwd, locked, "Edit", { file_path: "../escape.py" }).deny).toBe(true);
  });
  it("allows Write to a nested path under the workspace", () => {
    expect(evaluateLeash(cwd, locked, "Write", { file_path: "sub/dir/new_file.py" }).deny).toBe(false);
  });
  it("does not confine when no paths are locked (plan phase has no leash)", () => {
    expect(evaluateLeash(cwd, [], "Write", { file_path: "/anywhere/x.py" }).deny).toBe(false);
  });
});
