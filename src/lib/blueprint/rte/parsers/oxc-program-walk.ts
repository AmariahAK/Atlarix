/**
 * Shared ESTree walk: Program → BlueprintNode[] (used by main thread and parser worker).
 */

import type {
  ExportDefaultDeclaration,
  ExportNamedDeclaration,
  ImportDeclaration,
  Program,
  Statement,
  VariableDeclaration,
} from "@oxc-project/types";
import type { BlueprintNode } from "./types";

function safeId(prefix: string, file: string, name: string, index: number): string {
  return `${prefix}_${file.replace(/[^a-zA-Z0-9]/g, "_")}_${name}_${index}`;
}

function lineOf(node: unknown): number | undefined {
  const line = (node as { loc?: { start?: { line?: number } } } | null | undefined)?.loc?.start
    ?.line;
  return line != null && line > 0 ? line : undefined;
}

/**
 * Walk an oxc Program body and collect Blueprint nodes.
 */
export function walkProgramToNodes(
  program: Program,
  relPath: string,
  idOffset: number,
): BlueprintNode[] {
  const nodes: BlueprintNode[] = [];
  let idx = idOffset;

  const push = (node: Omit<BlueprintNode, "id" | "file"> & { id?: string }) => {
    const id = node.id ?? safeId("oxc", relPath, node.name, idx++);
    nodes.push({ ...node, id, file: relPath });
  };

  const visitStatement = (stmt: Statement) => {
    switch (stmt.type) {
      case "FunctionDeclaration": {
        const fd = stmt as { id?: { name?: string } };
        push({
          type: "function",
          name: fd.id?.name ?? "anonymous",
          line: lineOf(fd),
        });
        break;
      }
      case "ClassDeclaration": {
        const cd = stmt as { id?: { name?: string } };
        push({
          type: "class",
          name: cd.id?.name ?? "Anonymous",
          line: lineOf(cd),
        });
        break;
      }
      case "ImportDeclaration": {
        const imp = stmt as ImportDeclaration;
        const src = typeof imp.source?.value === "string" ? imp.source.value : "import";
        push({
          type: "feature",
          name: `import:${src}`,
          line: lineOf(imp),
          description: src,
        });
        break;
      }
      case "ExportNamedDeclaration": {
        const exp = stmt as ExportNamedDeclaration;
        if (exp.declaration) {
          if (exp.declaration.type === "FunctionDeclaration") {
            visitStatement(exp.declaration);
            if (exp.declaration.id) {
              push({
                type: "feature",
                name: `export:${exp.declaration.id.name}`,
                line: lineOf(exp),
              });
            }
          } else if (exp.declaration.type === "ClassDeclaration") {
            visitStatement(exp.declaration);
            if (exp.declaration.id) {
              push({
                type: "feature",
                name: `export:${exp.declaration.id.name}`,
                line: lineOf(exp),
              });
            }
          } else if (exp.declaration.type === "VariableDeclaration") {
            visitStatement(exp.declaration);
          }
        } else if (exp.specifiers?.length) {
          for (const spec of exp.specifiers) {
            const exported =
              spec.type === "ExportSpecifier"
                ? spec.exported.type === "Identifier"
                  ? spec.exported.name
                  : "export"
                : "export";
            push({
              type: "feature",
              name: `export:${exported}`,
              line: lineOf(exp),
            });
          }
        }
        break;
      }
      case "ExportDefaultDeclaration": {
        const exp = stmt as ExportDefaultDeclaration;
        const decl = exp.declaration;
        if (decl.type === "FunctionDeclaration" || decl.type === "ClassDeclaration") {
          visitStatement(decl);
        }
        let name = "default";
        if (decl.type === "Identifier") name = decl.name;
        else if (decl.type === "FunctionDeclaration" && decl.id) name = decl.id.name;
        else if (decl.type === "ClassDeclaration" && decl.id) name = decl.id.name;
        push({
          type: "feature",
          name: `export:${name}`,
          line: lineOf(exp),
        });
        break;
      }
      case "VariableDeclaration": {
        const vd = stmt as VariableDeclaration;
        for (const decl of vd.declarations) {
          if (decl.id.type !== "Identifier") continue;
          const init = decl.init;
          if (!init) continue;
          if (init.type === "ArrowFunctionExpression" || init.type === "FunctionExpression") {
            push({
              type: "function",
              name: decl.id.name,
              line: lineOf(decl),
            });
          }
        }
        break;
      }
      default:
        break;
    }
  };

  if (program.body) {
    for (const stmt of program.body) visitStatement(stmt);
  }

  return nodes;
}
