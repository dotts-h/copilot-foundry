import { readFile } from "node:fs/promises";
import { join } from "node:path";
import ts from "typescript";
import type { FileSymbols } from "../phases/map.js";

const JS_SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".mjs", ".cjs", ".jsx"]);
const UPPER_SNAKE = /^[A-Z][A-Z0-9_]*$/;

function scriptKindForExtension(ext: string): ts.ScriptKind {
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

function renderParameters(params: ts.NodeArray<ts.ParameterDeclaration>, source: ts.SourceFile): string {
  const parts: string[] = [];
  for (const param of params) {
    let part = param.name.getText(source);
    if (param.type) {
      part += `: ${param.type.getText(source)}`;
    } else if (param.questionToken) {
      part += "?";
    }
    if (param.initializer) {
      part += ` = ${param.initializer.getText(source)}`;
    }
    parts.push(part);
  }
  return parts.join(", ");
}

function functionSymbol(
  name: string,
  params: ts.NodeArray<ts.ParameterDeclaration>,
  returnType: ts.TypeNode | undefined,
  isAsync: boolean,
  source: ts.SourceFile,
  line: number,
): FileSymbols["functions"][number] {
  const prefix = isAsync ? "async " : "";
  const ret = returnType ? `: ${returnType.getText(source)}` : "";
  return {
    name,
    signature: `${prefix}${name}(${renderParameters(params, source)})${ret}`,
    line,
  };
}

function extractClassMethods(classNode: ts.ClassDeclaration, source: ts.SourceFile): FileSymbols["classes"][number]["methods"] {
  const methods: FileSymbols["classes"][number]["methods"] = [];
  for (const member of classNode.members) {
    if (ts.isPropertyDeclaration(member) && member.name && ts.isPrivateIdentifier(member.name)) {
      continue;
    }
    if (ts.isMethodDeclaration(member) || ts.isConstructorDeclaration(member)) {
      const name = ts.isConstructorDeclaration(member) ? "constructor" : member.name!.getText(source);
      if (name.startsWith("#")) continue;
      methods.push(
        functionSymbol(
          name,
          member.parameters,
          member.type,
          Boolean(member.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword)),
          source,
          source.getLineAndCharacterOfPosition(member.getStart(source)).line + 1,
        ),
      );
    }
  }
  return methods;
}

function extractFileSymbols(sourceText: string, fileName: string): FileSymbols | null {
  const ext = fileName.slice(fileName.lastIndexOf("."));
  const parsed = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, true, scriptKindForExtension(ext));
  const parseDiagnostics = (parsed as ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics;
  if (parseDiagnostics && parseDiagnostics.length > 0) {
    return { functions: [], classes: [], constants: [], error: "unparsed" };
  }
  const functions: FileSymbols["functions"] = [];
  const classes: FileSymbols["classes"] = [];
  const constants: string[] = [];

  for (const node of parsed.statements) {
    if (ts.isFunctionDeclaration(node) && node.name) {
      functions.push(
        functionSymbol(
          node.name.text,
          node.parameters,
          node.type,
          Boolean(node.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword)),
          parsed,
          parsed.getLineAndCharacterOfPosition(node.getStart(parsed)).line + 1,
        ),
      );
    } else if (ts.isClassDeclaration(node) && node.name) {
      classes.push({
        name: node.name.text,
        line: parsed.getLineAndCharacterOfPosition(node.getStart(parsed)).line + 1,
        methods: extractClassMethods(node, parsed),
      });
    } else if (ts.isVariableStatement(node)) {
      for (const decl of node.declarationList.declarations) {
        if (!ts.isIdentifier(decl.name)) continue;
        const name = decl.name.text;
        if (UPPER_SNAKE.test(name)) {
          constants.push(name);
        }
        if (
          decl.initializer &&
          (ts.isArrowFunction(decl.initializer) || ts.isFunctionExpression(decl.initializer))
        ) {
          const fn = decl.initializer;
          functions.push(
            functionSymbol(
              name,
              fn.parameters,
              fn.type,
              Boolean(fn.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword)),
              parsed,
              parsed.getLineAndCharacterOfPosition(decl.getStart(parsed)).line + 1,
            ),
          );
        }
      }
    }
  }

  if (functions.length === 0 && classes.length === 0 && constants.length === 0) {
    return null;
  }
  return { functions, classes, constants };
}

export async function extractJsSymbols(targetDir: string, files: string[]): Promise<Record<string, FileSymbols>> {
  const output: Record<string, FileSymbols> = {};

  for (const relPath of files) {
    const ext = relPath.slice(relPath.lastIndexOf("."));
    if (!JS_SOURCE_EXTENSIONS.has(ext)) continue;

    try {
      const sourceText = await readFile(join(targetDir, relPath), "utf8");
      const symbols = extractFileSymbols(sourceText, relPath);
      if (symbols) {
        output[relPath] = symbols;
      }
    } catch {
      output[relPath] = { functions: [], classes: [], constants: [], error: "unparsed" };
    }
  }

  return output;
}
