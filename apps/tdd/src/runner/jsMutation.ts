import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import ts from "typescript";
import type { MutationScoreResult, OperatorMutationResult } from "../gates/mutationGate.js";
import type { MutationOptions, TestRunResult } from "./types.js";
import { classifyJsRun } from "./jsClassify.js";

type JsMutationOperator = "arithmetic-swap" | "comparison-swap" | "boolean-negation";

const ARITH_SWAP: Partial<Record<ts.SyntaxKind, ts.SyntaxKind>> = {
  [ts.SyntaxKind.PlusToken]: ts.SyntaxKind.MinusToken,
  [ts.SyntaxKind.MinusToken]: ts.SyntaxKind.PlusToken,
  [ts.SyntaxKind.AsteriskToken]: ts.SyntaxKind.SlashToken,
  [ts.SyntaxKind.SlashToken]: ts.SyntaxKind.AsteriskToken,
};

const CMP_SWAP: Partial<Record<ts.SyntaxKind, ts.SyntaxKind>> = {
  [ts.SyntaxKind.LessThanToken]: ts.SyntaxKind.GreaterThanEqualsToken,
  [ts.SyntaxKind.LessThanEqualsToken]: ts.SyntaxKind.GreaterThanToken,
  [ts.SyntaxKind.GreaterThanToken]: ts.SyntaxKind.LessThanEqualsToken,
  [ts.SyntaxKind.GreaterThanEqualsToken]: ts.SyntaxKind.LessThanToken,
  [ts.SyntaxKind.EqualsEqualsToken]: ts.SyntaxKind.ExclamationEqualsToken,
  [ts.SyntaxKind.ExclamationEqualsToken]: ts.SyntaxKind.EqualsEqualsToken,
  [ts.SyntaxKind.EqualsEqualsEqualsToken]: ts.SyntaxKind.ExclamationEqualsEqualsToken,
  [ts.SyntaxKind.ExclamationEqualsEqualsToken]: ts.SyntaxKind.EqualsEqualsEqualsToken,
};

function scriptKindForFile(fileName: string): ts.ScriptKind {
  const ext = fileName.slice(fileName.lastIndexOf("."));
  switch (ext) {
    case ".tsx":
      return ts.ScriptKind.TSX;
    case ".jsx":
      return ts.ScriptKind.JSX;
    case ".ts":
    case ".mts":
    case ".cts":
      return ts.ScriptKind.TS;
    default:
      return ts.ScriptKind.JS;
  }
}

function findTargetFunction(
  sourceFile: ts.SourceFile,
  functionName: string,
): ts.FunctionDeclaration | ts.ArrowFunction | ts.FunctionExpression | null {
  for (const node of sourceFile.statements) {
    if (ts.isFunctionDeclaration(node) && node.name?.text === functionName) {
      return node;
    }
    if (ts.isVariableStatement(node)) {
      for (const decl of node.declarationList.declarations) {
        if (!ts.isIdentifier(decl.name) || decl.name.text !== functionName || !decl.initializer) continue;
        if (ts.isArrowFunction(decl.initializer) || ts.isFunctionExpression(decl.initializer)) {
          return decl.initializer;
        }
      }
    }
  }
  return null;
}

function replaceSpan(source: string, start: number, end: number, replacement: string): string {
  return source.slice(0, start) + replacement + source.slice(end);
}

function swapOperatorToken(source: string, sourceFile: ts.SourceFile, node: ts.BinaryExpression, swapMap: Partial<Record<ts.SyntaxKind, ts.SyntaxKind>>): string | null {
  const opKind = node.operatorToken.kind;
  const newKind = swapMap[opKind];
  if (newKind === undefined) return null;
  const opText = ts.tokenToString(newKind);
  if (!opText) return null;
  const start = node.operatorToken.getStart(sourceFile);
  const end = node.operatorToken.getEnd();
  return replaceSpan(source, start, end, opText);
}

export function applyJsMutation(source: string, fileName: string, functionName: string, operator: JsMutationOperator): string | null {
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, scriptKindForFile(fileName));
  const targetFn = findTargetFunction(sourceFile, functionName);
  if (!targetFn) return null;

  const visit = (node: ts.Node): string | null => {
    if (operator === "arithmetic-swap" && ts.isBinaryExpression(node)) {
      const mutated = swapOperatorToken(source, sourceFile, node, ARITH_SWAP);
      if (mutated) return mutated;
    }
    if (operator === "comparison-swap" && ts.isBinaryExpression(node)) {
      const mutated = swapOperatorToken(source, sourceFile, node, CMP_SWAP);
      if (mutated) return mutated;
    }
    if (operator === "boolean-negation" && ts.isReturnStatement(node) && node.expression) {
      const exprStart = node.expression.getStart(sourceFile);
      const exprEnd = node.expression.getEnd();
      const exprText = source.slice(exprStart, exprEnd);
      return replaceSpan(source, exprStart, exprEnd, `!(${exprText})`);
    }
    return ts.forEachChild(node, visit) ?? null;
  };

  return visit(targetFn);
}

async function applyOperatorMutation(
  opts: MutationOptions,
  operator: JsMutationOperator,
  framework: "vitest" | "jest",
  runTestsFocused: () => Promise<TestRunResult>,
): Promise<OperatorMutationResult> {
  const implPath = join(opts.workDir, opts.implRelPath);
  const originalSource = await readFile(implPath, "utf8");
  const mutatedSource = applyJsMutation(originalSource, opts.implRelPath, opts.functionName, operator);

  if (mutatedSource === null) {
    return { operator, applied: false, survived: null };
  }

  try {
    await writeFile(implPath, mutatedSource);
    const testResult = await runTestsFocused();
    if (classifyJsRun(framework, testResult) === "harness_error") {
      return { operator, applied: false, survived: null };
    }
    return { operator, applied: true, survived: testResult.exitCode === 0 };
  } finally {
    await writeFile(implPath, originalSource);
  }
}

export async function computeJsMutationScore(
  runTestsFocused: () => Promise<TestRunResult>,
  opts: MutationOptions,
  framework: "vitest" | "jest" = "vitest",
): Promise<MutationScoreResult> {
  const operators: JsMutationOperator[] = ["arithmetic-swap", "comparison-swap", "boolean-negation"];
  const results: OperatorMutationResult[] = [];

  for (const operator of operators) {
    const result = await applyOperatorMutation(opts, operator, framework, runTestsFocused);
    results.push(result);
  }

  const attempted = results.filter((r) => r.applied);
  const killed = attempted.filter((r) => r.survived === false);
  const survived = attempted.filter((r) => r.survived === true);

  return {
    results,
    killedCount: killed.length,
    survivedCount: survived.length,
    attemptedCount: attempted.length,
    score: attempted.length === 0 ? 1 : killed.length / attempted.length,
  };
}
