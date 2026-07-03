import { randomBytes } from "node:crypto";
import { readFile, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCommand } from "../exec.js";
import type { MutationScoreResult, OperatorMutationResult } from "../gates/mutationGate.js";
import type { MutationOptions, TestRunResult } from "./types.js";

type GoSyntacticOperator = "arithmetic-swap" | "comparison-swap" | "boolean-negation";
type GoMutatorMode = GoSyntacticOperator | "constant-return";

const GO_MUTATOR = String.raw`//go:build ignore

package main

import (
	"encoding/json"
	"go/ast"
	"go/parser"
	"go/printer"
	"go/token"
	"os"
	"strings"
)

type MutationResult struct {
	Applicable    bool   ` + "`json:\"applicable\"`" + `
	MutatedSource string ` + "`json:\"mutatedSource,omitempty\"`" + `
}

type ExtractResult struct {
	Found   bool   ` + "`json:\"found\"`" + `
	Literal string ` + "`json:\"literal,omitempty\"`" + `
}

func isComparison(op token.Token) bool {
	switch op {
	case token.LSS, token.LEQ, token.GTR, token.GEQ, token.EQL, token.NEQ:
		return true
	default:
		return false
	}
}

func swapComparison(op token.Token) (token.Token, bool) {
	switch op {
	case token.LSS:
		return token.GEQ, true
	case token.LEQ:
		return token.GTR, true
	case token.GTR:
		return token.LEQ, true
	case token.GEQ:
		return token.LSS, true
	case token.EQL:
		return token.NEQ, true
	case token.NEQ:
		return token.EQL, true
	default:
		return op, false
	}
}

func swapArithmetic(op token.Token) (token.Token, bool) {
	switch op {
	case token.ADD:
		return token.SUB, true
	case token.SUB:
		return token.ADD, true
	case token.MUL:
		return token.QUO, true
	case token.QUO:
		return token.MUL, true
	default:
		return op, false
	}
}

func negateBooleanExpr(expr ast.Expr) (ast.Expr, bool) {
	switch node := expr.(type) {
	case *ast.BinaryExpr:
		if isComparison(node.Op) {
			return &ast.UnaryExpr{Op: token.NOT, X: node}, true
		}
	case *ast.UnaryExpr:
		if node.Op == token.NOT {
			return node.X, true
		}
	case *ast.Ident:
		if node.Name == "true" {
			return &ast.Ident{Name: "false"}, true
		}
		if node.Name == "false" {
			return &ast.Ident{Name: "true"}, true
		}
	}
	return nil, false
}

type mutator struct {
	operator   string
	targetName string
}

func (m *mutator) findTarget(file *ast.File) *ast.FuncDecl {
	for _, decl := range file.Decls {
		fn, ok := decl.(*ast.FuncDecl)
		if ok && fn.Name.Name == m.targetName {
			return fn
		}
	}
	return nil
}

func (m *mutator) apply(fn *ast.FuncDecl) bool {
	switch m.operator {
	case "arithmetic-swap":
		return m.walkArithmetic(fn.Body)
	case "comparison-swap":
		return m.walkComparison(fn.Body)
	case "boolean-negation":
		return m.walkBoolean(fn.Body)
	default:
		return false
	}
}

func (m *mutator) walkArithmetic(node ast.Node) bool {
	var found bool
	ast.Inspect(node, func(n ast.Node) bool {
		if found {
			return false
		}
		bin, ok := n.(*ast.BinaryExpr)
		if !ok {
			return true
		}
		newOp, ok := swapArithmetic(bin.Op)
		if !ok {
			return true
		}
		bin.Op = newOp
		found = true
		return false
	})
	return found
}

func (m *mutator) walkComparison(node ast.Node) bool {
	var found bool
	ast.Inspect(node, func(n ast.Node) bool {
		if found {
			return false
		}
		bin, ok := n.(*ast.BinaryExpr)
		if !ok {
			return true
		}
		newOp, ok := swapComparison(bin.Op)
		if !ok {
			return true
		}
		bin.Op = newOp
		found = true
		return false
	})
	return found
}

func (m *mutator) walkBoolean(node ast.Node) bool {
	var found bool
	ast.Inspect(node, func(n ast.Node) bool {
		if found {
			return false
		}
		ret, ok := n.(*ast.ReturnStmt)
		if !ok || len(ret.Results) != 1 {
			return true
		}
		negated, ok := negateBooleanExpr(ret.Results[0])
		if !ok {
			return true
		}
		ret.Results[0] = negated
		found = true
		return false
	})
	return found
}

func findTargetFunction(file *ast.File, targetName string) *ast.FuncDecl {
	for _, decl := range file.Decls {
		fn, ok := decl.(*ast.FuncDecl)
		if ok && fn.Name.Name == targetName {
			return fn
		}
	}
	return nil
}

func isBasicLitExpr(expr ast.Expr) (ast.Expr, bool) {
	switch node := expr.(type) {
	case *ast.BasicLit:
		return node, true
	case *ast.UnaryExpr:
		if node.Op == token.SUB {
			if _, ok := node.X.(*ast.BasicLit); ok {
				return node, true
			}
		}
	}
	return nil, false
}

func isTargetCall(expr ast.Expr, functionName string) bool {
	call, ok := expr.(*ast.CallExpr)
	if !ok {
		return false
	}
	ident, ok := call.Fun.(*ast.Ident)
	return ok && ident.Name == functionName
}

func literalSource(fset *token.FileSet, expr ast.Expr) (string, bool) {
	var out strings.Builder
	if err := printer.Fprint(&out, fset, expr); err != nil {
		return "", false
	}
	return out.String(), true
}

func extractFromCallCompare(bin *ast.BinaryExpr, functionName string, fset *token.FileSet) (string, bool) {
	if bin.Op != token.NEQ && bin.Op != token.EQL {
		return "", false
	}
	if isTargetCall(bin.X, functionName) {
		if lit, ok := isBasicLitExpr(bin.Y); ok {
			if text, ok := literalSource(fset, lit); ok {
				return text, true
			}
		}
	}
	if isTargetCall(bin.Y, functionName) {
		if lit, ok := isBasicLitExpr(bin.X); ok {
			if text, ok := literalSource(fset, lit); ok {
				return text, true
			}
		}
	}
	return "", false
}

func extractFromIdentCompare(bin *ast.BinaryExpr, varName string, fset *token.FileSet) (string, bool) {
	if bin.Op != token.NEQ && bin.Op != token.EQL {
		return "", false
	}
	if ident, ok := bin.X.(*ast.Ident); ok && ident.Name == varName {
		if lit, ok := isBasicLitExpr(bin.Y); ok {
			if text, ok := literalSource(fset, lit); ok {
				return text, true
			}
		}
	}
	if ident, ok := bin.Y.(*ast.Ident); ok && ident.Name == varName {
		if lit, ok := isBasicLitExpr(bin.X); ok {
			if text, ok := literalSource(fset, lit); ok {
				return text, true
			}
		}
	}
	return "", false
}

func collectShortVarAssignments(body *ast.BlockStmt, functionName string) map[string]bool {
	vars := map[string]bool{}
	if body == nil {
		return vars
	}
	ast.Inspect(body, func(n ast.Node) bool {
		assign, ok := n.(*ast.AssignStmt)
		if !ok || assign.Tok != token.DEFINE {
			return true
		}
		for i, lhs := range assign.Lhs {
			ident, ok := lhs.(*ast.Ident)
			if !ok || i >= len(assign.Rhs) {
				continue
			}
			if isTargetCall(assign.Rhs[i], functionName) {
				vars[ident.Name] = true
			}
		}
		return true
	})
	return vars
}

func extractFromTestFunction(fn *ast.FuncDecl, functionName string, fset *token.FileSet) (string, bool) {
	if fn.Body == nil {
		return "", false
	}

	var found string
	var matched bool
	ast.Inspect(fn.Body, func(n ast.Node) bool {
		if matched {
			return false
		}
		bin, ok := n.(*ast.BinaryExpr)
		if !ok {
			return true
		}
		if text, ok := extractFromCallCompare(bin, functionName, fset); ok {
			found = text
			matched = true
			return false
		}
		return true
	})
	if matched {
		return found, true
	}

	assigned := collectShortVarAssignments(fn.Body, functionName)
	ast.Inspect(fn.Body, func(n ast.Node) bool {
		if matched {
			return false
		}
		bin, ok := n.(*ast.BinaryExpr)
		if !ok {
			return true
		}
		for varName := range assigned {
			if text, ok := extractFromIdentCompare(bin, varName, fset); ok {
				found = text
				matched = true
				return false
			}
		}
		return true
	})
	return found, matched
}

func runExtractExpected(testPath, functionName string) {
	source, err := os.ReadFile(testPath)
	if err != nil {
		_ = json.NewEncoder(os.Stdout).Encode(ExtractResult{Found: false})
		return
	}

	fset := token.NewFileSet()
	file, err := parser.ParseFile(fset, testPath, source, parser.ParseComments)
	if err != nil {
		_ = json.NewEncoder(os.Stdout).Encode(ExtractResult{Found: false})
		return
	}

	for _, decl := range file.Decls {
		fn, ok := decl.(*ast.FuncDecl)
		if !ok || !strings.HasPrefix(fn.Name.Name, "Test") {
			continue
		}
		if literal, found := extractFromTestFunction(fn, functionName, fset); found {
			_ = json.NewEncoder(os.Stdout).Encode(ExtractResult{Found: true, Literal: literal})
			return
		}
	}
	_ = json.NewEncoder(os.Stdout).Encode(ExtractResult{Found: false})
}

func runConstantReturn(implPath, functionName, literalText string) {
	expr, err := parser.ParseExpr(literalText)
	if err != nil {
		_ = json.NewEncoder(os.Stdout).Encode(MutationResult{Applicable: false})
		return
	}

	source, err := os.ReadFile(implPath)
	if err != nil {
		_ = json.NewEncoder(os.Stdout).Encode(MutationResult{Applicable: false})
		return
	}

	fset := token.NewFileSet()
	file, err := parser.ParseFile(fset, implPath, source, parser.ParseComments)
	if err != nil {
		_ = json.NewEncoder(os.Stdout).Encode(MutationResult{Applicable: false})
		return
	}

	target := findTargetFunction(file, functionName)
	if target == nil {
		_ = json.NewEncoder(os.Stdout).Encode(MutationResult{Applicable: false})
		return
	}

	target.Body = &ast.BlockStmt{
		List: []ast.Stmt{
			&ast.ReturnStmt{Results: []ast.Expr{expr}},
		},
	}

	var out strings.Builder
	if err := printer.Fprint(&out, fset, file); err != nil {
		_ = json.NewEncoder(os.Stdout).Encode(MutationResult{Applicable: false})
		return
	}

	_ = json.NewEncoder(os.Stdout).Encode(MutationResult{
		Applicable:    true,
		MutatedSource: out.String(),
	})
}

func programArgs() []string {
	args := os.Args[1:]
	if len(args) > 0 && args[0] == "--" {
		return args[1:]
	}
	return args
}

func main() {
	args := programArgs()
	if len(args) < 3 {
		os.Exit(1)
	}

	if args[2] == "extract-expected" {
		runExtractExpected(args[0], args[1])
		return
	}

	if len(args) >= 4 && args[3] == "constant-return" {
		runConstantReturn(args[0], args[1], args[2])
		return
	}

	implPath := args[0]
	functionName := args[1]
	operator := args[2]

	source, err := os.ReadFile(implPath)
	if err != nil {
		_ = json.NewEncoder(os.Stdout).Encode(MutationResult{Applicable: false})
		return
	}

	fset := token.NewFileSet()
	file, err := parser.ParseFile(fset, implPath, source, parser.ParseComments)
	if err != nil {
		_ = json.NewEncoder(os.Stdout).Encode(MutationResult{Applicable: false})
		return
	}

	m := &mutator{operator: operator, targetName: functionName}
	target := m.findTarget(file)
	if target == nil || !m.apply(target) {
		_ = json.NewEncoder(os.Stdout).Encode(MutationResult{Applicable: false})
		return
	}

	var out strings.Builder
	if err := printer.Fprint(&out, fset, file); err != nil {
		_ = json.NewEncoder(os.Stdout).Encode(MutationResult{Applicable: false})
		return
	}

	_ = json.NewEncoder(os.Stdout).Encode(MutationResult{
		Applicable:    true,
		MutatedSource: out.String(),
	})
}
`;

async function runGoMutatorScript(args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const scriptPath = join(tmpdir(), `tdd-mutate-${randomBytes(8).toString("hex")}.go`);
  try {
    await writeFile(scriptPath, GO_MUTATOR, "utf8");
    return await runCommand("go", ["run", scriptPath, "--", ...args], { timeoutMs: 30_000 });
  } finally {
    await unlink(scriptPath).catch(() => {});
  }
}

export async function runGoExtractExpected(
  testPath: string,
  functionName: string,
): Promise<{ found: boolean; literal?: string; error?: string }> {
  try {
    const result = await runGoMutatorScript([testPath, functionName, "extract-expected"]);
    if (result.exitCode !== 0) {
      return {
        found: false,
        error: `go mutator failed (exit ${result.exitCode}): ${result.stderr}`,
      };
    }
    try {
      return JSON.parse(result.stdout.trim()) as { found: boolean; literal?: string };
    } catch {
      return {
        found: false,
        error: `go mutator returned invalid JSON: ${result.stdout}`,
      };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { found: false, error: message };
  }
}

export async function runGoMutator(
  implPath: string,
  functionName: string,
  operator: GoMutatorMode,
  literalText?: string,
): Promise<{ applicable: boolean; mutatedSource?: string; error?: string }> {
  try {
    const args =
      operator === "constant-return"
        ? [implPath, functionName, literalText ?? "", "constant-return"]
        : [implPath, functionName, operator];
    const result = await runGoMutatorScript(args);
    if (result.exitCode !== 0) {
      return {
        applicable: false,
        error: `go mutator failed (exit ${result.exitCode}): ${result.stderr}`,
      };
    }
    try {
      const parsed = JSON.parse(result.stdout.trim()) as { applicable: boolean; mutatedSource?: string };
      if (!parsed.applicable || parsed.mutatedSource === undefined) {
        return { applicable: false };
      }
      return parsed;
    } catch {
      return {
        applicable: false,
        error: `go mutator returned invalid JSON: ${result.stdout}`,
      };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { applicable: false, error: message };
  }
}

export const goMutationDeps = { runGoMutator, runGoExtractExpected };

async function applyConstantMutation(
  opts: MutationOptions,
  testPath: string,
  runTestsFocused: () => Promise<TestRunResult>,
  classifyRun: (result: TestRunResult) => "passed" | "failed" | "harness_error",
): Promise<OperatorMutationResult> {
  const implPath = join(opts.workDir, opts.implRelPath);
  const originalSource = await readFile(implPath, "utf8");

  const extraction = await goMutationDeps.runGoExtractExpected(testPath, opts.functionName);
  if (extraction.error) {
    return { operator: "constant", outcome: "error", survived: null, reason: extraction.error };
  }
  if (!extraction.found || extraction.literal === undefined) {
    return { operator: "constant", outcome: "not_applicable", survived: null };
  }

  const mutation = await goMutationDeps.runGoMutator(
    implPath,
    opts.functionName,
    "constant-return",
    extraction.literal,
  );
  if (mutation.error) {
    return { operator: "constant", outcome: "error", survived: null, reason: mutation.error };
  }
  if (!mutation.applicable || mutation.mutatedSource === undefined) {
    return { operator: "constant", outcome: "not_applicable", survived: null };
  }

  try {
    await writeFile(implPath, mutation.mutatedSource);
    const testResult = await runTestsFocused();
    if (classifyRun(testResult) === "harness_error") {
      // Non-compiling mutant discarded per spec: go test reports compile failures as harness_error.
      return { operator: "constant", outcome: "not_applicable", survived: null };
    }
    return { operator: "constant", outcome: "applied", survived: testResult.exitCode === 0 };
  } finally {
    await writeFile(implPath, originalSource);
  }
}

async function applyOperatorMutation(
  opts: MutationOptions,
  operator: GoSyntacticOperator,
  runTestsFocused: () => Promise<TestRunResult>,
  classifyRun: (result: TestRunResult) => "passed" | "failed" | "harness_error",
): Promise<OperatorMutationResult> {
  const implPath = join(opts.workDir, opts.implRelPath);
  const originalSource = await readFile(implPath, "utf8");
  const mutation = await goMutationDeps.runGoMutator(implPath, opts.functionName, operator);

  if (mutation.error) {
    return { operator, outcome: "error", survived: null, reason: mutation.error };
  }

  if (!mutation.applicable || mutation.mutatedSource === undefined) {
    return { operator, outcome: "not_applicable", survived: null };
  }

  try {
    await writeFile(implPath, mutation.mutatedSource);
    const testResult = await runTestsFocused();
    if (classifyRun(testResult) === "harness_error") {
      return { operator, outcome: "not_applicable", survived: null };
    }
    return { operator, outcome: "applied", survived: testResult.exitCode === 0 };
  } finally {
    await writeFile(implPath, originalSource);
  }
}

export async function computeGoMutationScore(
  runTestsFocused: () => Promise<TestRunResult>,
  opts: MutationOptions,
  classifyRun: (result: TestRunResult) => "passed" | "failed" | "harness_error",
  testPath: string,
): Promise<MutationScoreResult> {
  const operators: GoSyntacticOperator[] = ["arithmetic-swap", "comparison-swap", "boolean-negation"];
  const results: OperatorMutationResult[] = [];

  results.push(await applyConstantMutation(opts, testPath, runTestsFocused, classifyRun));

  for (const operator of operators) {
    const result = await applyOperatorMutation(opts, operator, runTestsFocused, classifyRun);
    results.push(result);
  }

  const attempted = results.filter((r) => r.outcome === "applied");
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
