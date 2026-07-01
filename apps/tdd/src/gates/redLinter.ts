export interface RedLintResult {
  blocking: string[];
  warnings: string[];
}

function countAssertions(source: string): number {
  const matches = source.match(/^\s*assert\b/gm);
  return matches ? matches.length : 0;
}

export function lintRedTest(testSource: string): RedLintResult {
  const blocking: string[] = [];
  const warnings: string[] = [];

  if (testSource.trim().length === 0) {
    blocking.push("test file is empty");
    return { blocking, warnings };
  }

  const assertionCount = countAssertions(testSource);
  if (assertionCount === 0) {
    blocking.push("no assert statements found");
  } else if (assertionCount === 1) {
    warnings.push(
      "only one assertion found -- a single example does not triangulate; consider a second, differently-valued case",
    );
  }

  if (/==\s*True\b/.test(testSource) || /==\s*False\b/.test(testSource)) {
    warnings.push("uses == True / == False literal comparisons -- prefer a plain truthy/falsy assertion");
  }

  const literalAssertions = [...testSource.matchAll(/assert\s+[^=\n]+==\s*([^\n#]+)/g)].map((m) => m[1].trim());
  const testFnCount = (testSource.match(/^\s*def\s+test_\w+/gm) ?? []).length;
  if (testFnCount > 1 && literalAssertions.length > 1 && new Set(literalAssertions).size === 1) {
    warnings.push(
      "all assertions across multiple test functions target the same expected value; suite may not triangulate distinct behaviors",
    );
  }

  return { blocking, warnings };
}
