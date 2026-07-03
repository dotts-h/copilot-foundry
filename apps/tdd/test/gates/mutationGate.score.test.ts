import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const FIXTURE_VENV = join(process.cwd(), "fixtures", "add-kata", ".venv");

vi.mock("../../src/exec.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/exec.js")>();
  return {
    ...actual,
    runCommand: vi.fn(async (cmd, args, opts) => {
      if (args.length === 5 && typeof args[4] === "string" && args[4].endsWith(".py")) {
        return { exitCode: 1, stdout: "", stderr: "broken python" };
      }
      return actual.runCommand(cmd, args, opts);
    }),
  };
});

const { computeMutationScore } = await import("../../src/gates/mutationGate.js");

describe("computeMutationScore score semantics with operator errors", () => {
  let dir: string;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("excludes error results from the score while keeping them visible in results", async () => {
    dir = mkdtempSync(join(tmpdir(), "mutation-score-"));
    writeFileSync(join(dir, "rank.py"), "def rank(a, b):\n    return a + b > 0\n");
    writeFileSync(
      join(dir, "test_rank.py"),
      "from rank import rank\n\ndef test_rank():\n    assert rank(2, 3) == True\n    assert rank(-1, -1) == False\n",
    );

    const score = await computeMutationScore({
      workDir: dir,
      venvDir: FIXTURE_VENV,
      implRelPath: "rank.py",
      functionName: "rank",
      testRelPath: "test_rank.py",
    });

    const constant = score.results.find((r) => r.operator === "constant");
    expect(constant?.outcome).toBe("error");
    expect(constant?.reason?.length).toBeGreaterThan(0);
    expect(score.attemptedCount).toBe(3);
    expect(score.killedCount).toBe(3);
    expect(score.score).toBe(1);
  });
});
