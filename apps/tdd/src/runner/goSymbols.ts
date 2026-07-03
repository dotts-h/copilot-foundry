import { randomBytes } from "node:crypto";
import { unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCommand } from "../exec.js";
import type { FileSymbols } from "../phases/map.js";
import type { FunctionSpan } from "./types.js";

const GO_SYMBOL_EXTRACTOR = String.raw`//go:build ignore

package main

import (
	"bufio"
	"encoding/json"
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"strings"
)

type FunctionSymbol struct {
	Name      string ` + "`json:\"name\"`" + `
	Signature string ` + "`json:\"signature\"`" + `
	Line      int    ` + "`json:\"line\"`" + `
}

type ClassSymbol struct {
	Name    string           ` + "`json:\"name\"`" + `
	Line    int              ` + "`json:\"line\"`" + `
	Methods []FunctionSymbol ` + "`json:\"methods\"`" + `
}

type FileResult struct {
	Functions []FunctionSymbol ` + "`json:\"functions\"`" + `
	Classes   []ClassSymbol    ` + "`json:\"classes\"`" + `
	Constants []string         ` + "`json:\"constants\"`" + `
	Error     string           ` + "`json:\"error,omitempty\"`" + `
}

func renderField(field *ast.Field) string {
	if len(field.Names) == 0 {
		return astExprString(field.Type)
	}
	parts := make([]string, len(field.Names))
	for i, name := range field.Names {
		parts[i] = name.Name
	}
	typ := astExprString(field.Type)
	if len(parts) == 1 {
		return parts[0] + " " + typ
	}
	return strings.Join(parts, ", ") + " " + typ
}

func renderParams(fields []*ast.Field) string {
	if len(fields) == 0 {
		return ""
	}
	parts := make([]string, 0, len(fields))
	for _, field := range fields {
		parts = append(parts, renderField(field))
	}
	return strings.Join(parts, ", ")
}

func renderResults(results *ast.FieldList) string {
	if results == nil || len(results.List) == 0 {
		return ""
	}
	if len(results.List) == 1 && len(results.List[0].Names) == 0 {
		return " " + astExprString(results.List[0].Type)
	}
	named := make([]string, 0, len(results.List))
	for _, field := range results.List {
		named = append(named, renderField(field))
	}
	return " (" + strings.Join(named, ", ") + ")"
}

func astExprString(expr ast.Expr) string {
	switch t := expr.(type) {
	case *ast.Ident:
		return t.Name
	case *ast.StarExpr:
		return "*" + astExprString(t.X)
	case *ast.SelectorExpr:
		return astExprString(t.X) + "." + t.Sel.Name
	case *ast.ArrayType:
		if t.Len == nil {
			return "[]" + astExprString(t.Elt)
		}
		return "[...]" + astExprString(t.Elt)
	case *ast.MapType:
		return "map[" + astExprString(t.Key) + "]" + astExprString(t.Value)
	case *ast.InterfaceType:
		return "interface{}"
	case *ast.StructType:
		return "struct{}"
	case *ast.ChanType:
		return "chan " + astExprString(t.Value)
	case *ast.FuncType:
		return "func(" + renderParams(t.Params.List) + ")" + renderResults(t.Results)
	default:
		return "interface{}"
	}
}

func renderSignature(name string, fn *ast.FuncType) string {
	return "func " + name + "(" + renderParams(fn.Params.List) + ")" + renderResults(fn.Results)
}

func receiverTypeName(recv *ast.FieldList) string {
	if recv == nil || len(recv.List) == 0 {
		return ""
	}
	return strings.TrimPrefix(astExprString(recv.List[0].Type), "*")
}

func extractConstants(file *ast.File) []string {
	constants := []string{}
	for _, decl := range file.Decls {
		gen, ok := decl.(*ast.GenDecl)
		if !ok || gen.Tok != token.CONST {
			continue
		}
		for _, spec := range gen.Specs {
			valueSpec, ok := spec.(*ast.ValueSpec)
			if !ok {
				continue
			}
			for _, name := range valueSpec.Names {
				constants = append(constants, name.Name)
			}
		}
	}
	return constants
}

func extractFileSymbols(source string, filename string) *FileResult {
	fset := token.NewFileSet()
	file, err := parser.ParseFile(fset, filename, source, parser.ParseComments)
	if err != nil {
		return &FileResult{
			Functions: []FunctionSymbol{},
			Classes:   []ClassSymbol{},
			Constants: []string{},
			Error:     "unparsed",
		}
	}

	functions := []FunctionSymbol{}
	classes := []ClassSymbol{}
	methodsByType := map[string][]FunctionSymbol{}

	for _, decl := range file.Decls {
		fn, ok := decl.(*ast.FuncDecl)
		if !ok {
			continue
		}
		line := fset.Position(fn.Pos()).Line
		if fn.Recv == nil {
			functions = append(functions, FunctionSymbol{
				Name:      fn.Name.Name,
				Signature: renderSignature(fn.Name.Name, fn.Type),
				Line:      line,
			})
			continue
		}
		recvType := receiverTypeName(fn.Recv)
		methodsByType[recvType] = append(methodsByType[recvType], FunctionSymbol{
			Name:      fn.Name.Name,
			Signature: renderSignature(fn.Name.Name, fn.Type),
			Line:      line,
		})
	}

	for _, decl := range file.Decls {
		gen, ok := decl.(*ast.GenDecl)
		if !ok || gen.Tok != token.TYPE {
			continue
		}
		for _, spec := range gen.Specs {
			typeSpec, ok := spec.(*ast.TypeSpec)
			if !ok {
				continue
			}
			line := fset.Position(typeSpec.Pos()).Line
			methods := methodsByType[typeSpec.Name.Name]
			if methods == nil {
				methods = []FunctionSymbol{}
			}
			if iface, ok := typeSpec.Type.(*ast.InterfaceType); ok && iface.Methods != nil {
				for _, field := range iface.Methods.List {
					if len(field.Names) == 0 {
						continue
					}
					for _, name := range field.Names {
						fnType, ok := field.Type.(*ast.FuncType)
						if !ok {
							continue
						}
						methods = append(methods, FunctionSymbol{
							Name:      name.Name,
							Signature: renderSignature(name.Name, fnType),
							Line:      fset.Position(field.Pos()).Line,
						})
					}
				}
			}
			classes = append(classes, ClassSymbol{
				Name:    typeSpec.Name.Name,
				Line:    line,
				Methods: methods,
			})
		}
	}

	constants := extractConstants(file)
	if len(functions) == 0 && len(classes) == 0 && len(constants) == 0 {
		return nil
	}
	return &FileResult{
		Functions: functions,
		Classes:   classes,
		Constants: constants,
	}
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
	if len(args) < 1 {
		os.Exit(1)
	}
	root := args[0]
	output := map[string]FileResult{}

	scanner := bufio.NewScanner(os.Stdin)
	for scanner.Scan() {
		relPath := strings.TrimSpace(scanner.Text())
		if relPath == "" {
			continue
		}
		path := filepath.Join(root, relPath)
		source, err := os.ReadFile(path)
		if err != nil {
			output[relPath] = FileResult{
				Functions: []FunctionSymbol{},
				Classes:   []ClassSymbol{},
				Constants: []string{},
				Error:     "unparsed",
			}
			continue
		}
		symbols := extractFileSymbols(string(source), relPath)
		if symbols == nil {
			continue
		}
		output[relPath] = *symbols
	}

	enc := json.NewEncoder(os.Stdout)
	enc.SetEscapeHTML(false)
	_ = enc.Encode(output)
}
`;

const GO_FUNCTION_SPANS_EXTRACTOR = String.raw`//go:build ignore

package main

import (
	"encoding/json"
	"go/ast"
	"go/parser"
	"go/token"
	"os"
)

type Span struct {
	Name      string ` + "`json:\"name\"`" + `
	StartLine int    ` + "`json:\"startLine\"`" + `
	EndLine   int    ` + "`json:\"endLine\"`" + `
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
	if len(args) < 1 {
		os.Exit(1)
	}
	path := args[0]
	source, err := os.ReadFile(path)
	if err != nil {
		os.Exit(1)
	}
	fset := token.NewFileSet()
	file, err := parser.ParseFile(fset, path, source, parser.ParseComments)
	if err != nil {
		os.Exit(1)
	}
	spans := []Span{}
	for _, decl := range file.Decls {
		fn, ok := decl.(*ast.FuncDecl)
		if !ok {
			continue
		}
		spans = append(spans, Span{
			Name:      fn.Name.Name,
			StartLine: fset.Position(fn.Pos()).Line,
			EndLine:   fset.Position(fn.End()).Line,
		})
	}
	enc := json.NewEncoder(os.Stdout)
	enc.SetEscapeHTML(false)
	_ = enc.Encode(spans)
}
`;

export async function extractGoFunctionSpans(filePath: string): Promise<FunctionSpan[]> {
  const scriptPath = join(tmpdir(), `tdd-spans-extract-${randomBytes(8).toString("hex")}.go`);
  try {
    await writeFile(scriptPath, GO_FUNCTION_SPANS_EXTRACTOR, "utf8");
    const result = await runCommand("go", ["run", scriptPath, "--", filePath], {
      timeoutMs: 30_000,
    });
    if (result.exitCode !== 0) return [];
    try {
      const parsed: unknown = JSON.parse(result.stdout.trim());
      if (!Array.isArray(parsed)) return [];
      return parsed.filter(
        (entry): entry is FunctionSpan =>
          typeof entry === "object" &&
          entry !== null &&
          typeof (entry as FunctionSpan).name === "string" &&
          typeof (entry as FunctionSpan).startLine === "number" &&
          typeof (entry as FunctionSpan).endLine === "number",
      );
    } catch {
      return [];
    }
  } catch {
    return [];
  } finally {
    await unlink(scriptPath).catch(() => {});
  }
}

export async function extractGoSymbols(targetDir: string, files: string[]): Promise<Record<string, FileSymbols>> {
  if (files.length === 0) return {};

  const scriptPath = join(tmpdir(), `tdd-map-extract-${randomBytes(8).toString("hex")}.go`);
  try {
    await writeFile(scriptPath, GO_SYMBOL_EXTRACTOR, "utf8");
    const result = await runCommand("go", ["run", scriptPath, "--", targetDir], {
      stdin: files.join("\n"),
      timeoutMs: 30_000,
    });
    if (result.exitCode !== 0) return {};
    try {
      const parsed: unknown = JSON.parse(result.stdout.trim());
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
      return parsed as Record<string, FileSymbols>;
    } catch {
      return {};
    }
  } catch {
    return {};
  } finally {
    await unlink(scriptPath).catch(() => {});
  }
}
