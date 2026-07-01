import { describe, expect, it } from "vitest";
import { planSlices } from "../../src/phases/plan.js";
import { ScriptedBackend } from "../helpers/fakeBackend.js";
import type { RepoMap } from "../../src/phases/map.js";
import type { ScopeReport } from "../../src/phases/scope.js";

const EMPTY_MAP: RepoMap = { files: [], testFiles: [], imports: {} };
const REPO_SCOPE: ScopeReport = { inScope: [], reason: "scope=repo" };

describe("planSlices", () => {
  it("parses a well-formed JSON array of slices from the model", async () => {
    const backend = new ScriptedBackend([
      () => ({
        resultText: JSON.stringify([
          {
            description: "reverse words in a string",
            implRelPath: "strings_kata.py",
            testRelPath: "test_strings_kata.py",
            functionName: "reverse_words",
          },
          {
            description: "detect palindromes",
            implRelPath: "strings_kata.py",
            testRelPath: "test_strings_kata.py",
            functionName: "is_palindrome",
          },
        ]),
      }),
    ]);

    const slices = await planSlices({
      backend,
      model: "fake-plan",
      targetDir: "/tmp/whatever",
      featureDescription: "string utilities",
      repoMap: EMPTY_MAP,
      scopeReport: REPO_SCOPE,
    });

    expect(slices).toHaveLength(2);
    expect(slices[0].description).toMatch(/reverse/);
    expect(slices[0].functionName).toBe("reverse_words");
    expect(backend.calls[0].model).toBe("fake-plan");
  });

  it("forbids splitting a single function's input domain across multiple slices in the prompt", async () => {
    const backend = new ScriptedBackend([
      () => ({
        resultText: JSON.stringify([
          { description: "a", implRelPath: "x.py", testRelPath: "test_x.py", functionName: "a" },
        ]),
      }),
    ]);

    await planSlices({
      backend,
      model: "fake-plan",
      targetDir: "/tmp/whatever",
      featureDescription: "x",
      repoMap: EMPTY_MAP,
      scopeReport: REPO_SCOPE,
    });

    expect(backend.calls[0].prompt).toContain("Do NOT split a single function's input domain");
  });

  it("tolerates surrounding prose/markdown fences around the JSON array", async () => {
    const backend = new ScriptedBackend([
      () => ({
        resultText:
          'Here is the plan:\n```json\n[{"description":"a","implRelPath":"x.py","testRelPath":"test_x.py","functionName":"a"}]\n```\n',
      }),
    ]);

    const slices = await planSlices({
      backend,
      model: "fake-plan",
      targetDir: "/tmp/whatever",
      featureDescription: "x",
      repoMap: EMPTY_MAP,
      scopeReport: REPO_SCOPE,
    });

    expect(slices).toEqual([{ description: "a", implRelPath: "x.py", testRelPath: "test_x.py", functionName: "a" }]);
  });

  it("throws a clear error when the model response has no JSON array", async () => {
    const backend = new ScriptedBackend([() => ({ resultText: "sorry, I cannot help with that" })]);

    await expect(
      planSlices({
        backend,
        model: "fake-plan",
        targetDir: "/tmp/whatever",
        featureDescription: "x",
        repoMap: EMPTY_MAP,
        scopeReport: REPO_SCOPE,
      }),
    ).rejects.toThrow(/could not find a JSON array/);
  });

  it("throws when a planned slice is missing a required field", async () => {
    const backend = new ScriptedBackend([
      () => ({ resultText: JSON.stringify([{ description: "a", implRelPath: "x.py", functionName: "a" }]) }),
    ]);

    await expect(
      planSlices({
        backend,
        model: "fake-plan",
        targetDir: "/tmp/whatever",
        featureDescription: "x",
        repoMap: EMPTY_MAP,
        scopeReport: REPO_SCOPE,
      }),
    ).rejects.toThrow(/missing required fields/);
  });

  it("throws on an empty array -- planning must produce at least one slice", async () => {
    const backend = new ScriptedBackend([() => ({ resultText: "[]" })]);

    await expect(
      planSlices({
        backend,
        model: "fake-plan",
        targetDir: "/tmp/whatever",
        featureDescription: "x",
        repoMap: EMPTY_MAP,
        scopeReport: REPO_SCOPE,
      }),
    ).rejects.toThrow(/non-empty/);
  });
});
