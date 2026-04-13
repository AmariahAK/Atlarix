/**
 * Tree-sitter extraction for Python (workspace + RTE helpers).
 */

import type Parser from "tree-sitter";
import type { ParsedFileResult } from "@/lib/analysis/parsed-file-result";
import { walkNamed, lineOfIndex } from "./tree-sitter-parser";
import type { BlueprintNode } from "@/lib/blueprint/rte/parsers/types";

function dottedModuleText(node: Parser.SyntaxNode | null): string | null {
  if (!node) return null;
  if (node.type === "dotted_name") return node.text;
  if (node.type === "identifier" || node.type === "relative_import") return node.text;
  return null;
}

export function extractParsedFileResultFromPythonRoot(root: Parser.SyntaxNode, content: string): ParsedFileResult {
  const imports: string[] = [];
  const exports: string[] = [];
  const functions: string[] = [];
  const classes: string[] = [];
  const functionCalls: string[] = [];
  const classInstantiations: string[] = [];

  walkNamed(root, (node) => {
    if (node.type === "import_statement") {
      for (const ch of node.namedChildren) {
        if (ch.type === "dotted_name") imports.push(ch.text);
        if (ch.type === "aliased_import") {
          const n = ch.namedChildren.find((x) => x.type === "dotted_name");
          if (n) imports.push(n.text);
        }
      }
    } else if (node.type === "import_from_statement") {
      const dotted =
        node.namedChildren.find((c) => c.type === "dotted_name") ??
        node.childForFieldName?.("module_name");
      const rel = node.namedChildren.find((c) => c.type === "relative_import");
      const t = dottedModuleText(dotted ?? null) ?? (rel ? rel.text : null);
      if (t) imports.push(t);
    } else if (node.type === "function_definition" || node.type === "async_function_definition") {
      const nameNode = node.childForFieldName?.("name");
      if (nameNode?.type === "identifier") functions.push(nameNode.text);
    } else if (node.type === "class_definition") {
      const nameNode = node.childForFieldName?.("name");
      if (nameNode?.type === "identifier") classes.push(nameNode.text);
    } else if (node.type === "call") {
      const fn = node.childForFieldName?.("function") ?? node.namedChildren[0];
      if (fn?.type === "identifier") functionCalls.push(fn.text);
      else if (fn?.type === "attribute") {
        const attr = fn.childForFieldName?.("attribute");
        if (attr?.type === "identifier") functionCalls.push(attr.text);
      }
    }
  });

  const allMatch = content.match(/__all__\s*=\s*\[([\s\S]*?)\]/);
  if (allMatch) {
    for (const m of allMatch[1].matchAll(/['"](\w+)['"]/g)) {
      exports.push(m[1]);
    }
  }

  return {
    imports: [...new Set(imports)],
    exports: [...new Set(exports)],
    functions: [...new Set(functions)],
    classes: [...new Set(classes)],
    functionCalls: [...new Set(functionCalls)],
    classInstantiations: [...new Set(classInstantiations)],
  };
}

export function extractParsedFileResultFromPythonTree(tree: Parser.Tree, content: string): ParsedFileResult {
  return extractParsedFileResultFromPythonRoot(tree.rootNode, content);
}

function safeId(prefix: string, file: string, name: string, index: number): string {
  return `${prefix}_${file.replace(/[^a-zA-Z0-9]/g, "_")}_${name}_${index}`;
}

export function extractBlueprintNodesFromPython(
  content: string,
  tree: Parser.Tree,
  relPath: string,
  startIndex: number,
): BlueprintNode[] {
  const parsed = extractParsedFileResultFromPythonRoot(tree.rootNode, content);
  const nodes: BlueprintNode[] = [];
  let i = startIndex;
  const lineOf = (name: string) => {
    const re = new RegExp(`(^|\\n)\\s*(?:async\\s+)?def\\s+${name}\\s*\\(|(^|\\n)\\s*class\\s+${name}\\b`);
    const m = re.exec(content);
    return m ? lineOfIndex(content, m.index) : undefined;
  };
  for (const name of parsed.classes) {
    nodes.push({
      id: safeId("py_ts", relPath, name, i++),
      type: "class",
      name,
      file: relPath,
      line: lineOf(name),
    });
  }
  for (const name of parsed.functions) {
    nodes.push({
      id: safeId("py_ts", relPath, name, i++),
      type: "function",
      name,
      file: relPath,
      line: lineOf(name),
    });
  }
  return nodes;
}
