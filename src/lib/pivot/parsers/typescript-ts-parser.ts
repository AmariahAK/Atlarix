/**
 * Tree-sitter extraction for TypeScript / TSX / JavaScript (workspace + RTE helpers).
 */

import type Parser from "tree-sitter";
import type { ParsedFileResult } from "@/lib/analysis/parsed-file-result";
import type { GrammarKey } from "./grammar-loader";
import { walkNamed, lineOfIndex } from "./tree-sitter-parser";
import type { BlueprintNode } from "@/lib/blueprint/rte/parsers/types";

function stripQuotes(s: string): string {
  const t = s.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")) || (t.startsWith("`") && t.endsWith("`"))) {
    return t.slice(1, -1);
  }
  return t;
}

function importSourceFromStatement(node: Parser.SyntaxNode): string | null {
  const src = node.childForFieldName?.("source") ?? null;
  if (src) return stripQuotes(src.text);
  for (const c of node.namedChildren) {
    if (c.type === "string" || c.type === "string_fragment") {
      return stripQuotes(c.text);
    }
  }
  return null;
}

function identifierName(node: Parser.SyntaxNode | null): string | null {
  if (!node) return null;
  if (node.type === "identifier" || node.type === "property_identifier" || node.type === "private_property_identifier") {
    return node.text;
  }
  return null;
}

function exportNamesFromStatement(node: Parser.SyntaxNode, out: Set<string>): void {
  const clause = node.namedChildren.find((c) => c.type === "export_clause");
  if (clause) {
    for (const ch of clause.namedChildren) {
      if (ch.type === "export_specifier") {
        const name = ch.childForFieldName?.("name") ?? ch.namedChildren[0];
        const alias = ch.childForFieldName?.("alias");
        const pick = alias ?? name;
        const n = identifierName(pick ?? null);
        if (n) out.add(n);
      }
    }
  }
  const decl = node.namedChildren.find(
    (c) =>
      c.type === "function_declaration" ||
      c.type === "generator_function_declaration" ||
      c.type === "class_declaration" ||
      c.type === "lexical_declaration" ||
      c.type === "interface_declaration" ||
      c.type === "type_alias_declaration" ||
      c.type === "enum_declaration",
  );
  if (decl) {
    const nm = decl.childForFieldName?.("name");
    const n = identifierName(nm ?? null);
    if (n) out.add(n);
    if (decl.type === "lexical_declaration") {
      for (const vd of decl.namedChildren.filter((x) => x.type === "variable_declarator")) {
        const id = vd.childForFieldName?.("name");
        const nn = identifierName(id ?? null);
        if (nn) out.add(nn);
      }
    }
  }
  if (node.text.includes("export") && node.text.includes("default")) {
    const inner = node.namedChildren.find((c) => c.type !== "export" && c.type !== "default");
    if (inner) {
      const nm = inner.childForFieldName?.("name");
      const n = identifierName(nm ?? null);
      if (n) out.add(n);
    }
  }
}

function calleeName(call: Parser.SyntaxNode): string | null {
  const fn = call.childForFieldName?.("function") ?? call.namedChildren[0];
  if (!fn) return null;
  if (fn.type === "identifier") return fn.text;
  if (fn.type === "member_expression") {
    const prop = fn.childForFieldName?.("property");
    return identifierName(prop ?? null);
  }
  return null;
}

function newExpressionClassName(node: Parser.SyntaxNode): string | null {
  const ctor = node.namedChildren[0];
  if (!ctor) return null;
  if (ctor.type === "identifier") return ctor.text;
  if (ctor.type === "member_expression") {
    const prop = ctor.childForFieldName?.("property");
    return identifierName(prop ?? null);
  }
  return null;
}

export function extractParsedFileResultFromTsRoot(root: Parser.SyntaxNode): ParsedFileResult {
  const imports: string[] = [];
  const exports: string[] = [];
  const functions: string[] = [];
  const classes: string[] = [];
  const functionCalls: string[] = [];
  const classInstantiations: string[] = [];
  const exportSet = new Set<string>();

  walkNamed(root, (node) => {
    if (node.type === "import_statement") {
      const mod = importSourceFromStatement(node);
      if (mod) imports.push(mod);
    } else if (node.type === "export_statement") {
      exportNamesFromStatement(node, exportSet);
    } else if (node.type === "function_declaration" || node.type === "generator_function_declaration") {
      const nm = identifierName(node.childForFieldName?.("name") ?? null);
      if (nm) functions.push(nm);
    } else if (node.type === "method_definition") {
      const nm = identifierName(node.childForFieldName?.("name") ?? null);
      if (nm) functions.push(nm);
    } else if (node.type === "class_declaration") {
      const nm = identifierName(node.childForFieldName?.("name") ?? null);
      if (nm) classes.push(nm);
    } else if (node.type === "lexical_declaration") {
      for (const vd of node.namedChildren.filter((c) => c.type === "variable_declarator")) {
        const nameNode = vd.childForFieldName?.("name");
        const val = vd.childForFieldName?.("value");
        if (val && (val.type === "arrow_function" || val.type === "function_expression")) {
          const nn = identifierName(nameNode ?? null);
          if (nn) functions.push(nn);
        }
      }
    } else if (node.type === "call_expression") {
      const cn = calleeName(node);
      if (cn) functionCalls.push(cn);
    } else if (node.type === "new_expression") {
      const cn = newExpressionClassName(node);
      if (cn) classInstantiations.push(cn);
    }
  });

  exports.push(...exportSet);

  return {
    imports: [...new Set(imports)],
    exports: [...new Set(exports)],
    functions: [...new Set(functions)],
    classes: [...new Set(classes)],
    functionCalls: [...new Set(functionCalls)],
    classInstantiations: [...new Set(classInstantiations)],
  };
}

function safeId(prefix: string, file: string, name: string, index: number): string {
  return `${prefix}_${file.replace(/[^a-zA-Z0-9]/g, "_")}_${name}_${index}`;
}

/** Blueprint nodes from tree-sitter (functions/classes); APIs still come from regex. */
export function extractBlueprintNodesFromTsLike(
  content: string,
  tree: Parser.Tree,
  relPath: string,
  startIndex: number,
): BlueprintNode[] {
  const parsed = extractParsedFileResultFromTsRoot(tree.rootNode);
  const nodes: BlueprintNode[] = [];
  let i = startIndex;
  const lineOfName = (name: string) => {
    const idx = content.indexOf(name);
    return idx >= 0 ? lineOfIndex(content, idx) : undefined;
  };
  for (const name of parsed.classes) {
    nodes.push({
      id: safeId("ts_ts", relPath, name, i++),
      type: "class",
      name,
      file: relPath,
      line: lineOfName(name),
    });
  }
  for (const name of parsed.functions) {
    nodes.push({
      id: safeId("ts_ts", relPath, name, i++),
      type: "function",
      name,
      file: relPath,
      line: lineOfName(name),
    });
  }
  return nodes;
}
