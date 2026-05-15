/**
 * Lightweight file-structure extraction for TS/JS via oxc-parser (regex fallback).
 * Replaces removed tree-sitter-utils stubs for structure-scan / entry-point flows.
 */

import * as fs from "fs/promises";
import * as path from "path";
import type { Statement } from "@oxc-project/types";
import { OXC_MAX_BYTES } from "@/lib/blueprint/rte/parsers/oxc-extract";
import { oxcParseProgram } from "@/lib/blueprint/rte/parsers/oxc-parse";

export interface StructureResult {
  imports: string[];
  exports: string[];
  functions: string[];
  classes: string[];
  types?: string[];
  constants?: string[];
}

function isTsLikePath(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  return (
    lower.endsWith(".ts") ||
    lower.endsWith(".tsx") ||
    lower.endsWith(".js") ||
    lower.endsWith(".jsx")
  );
}

function walkOxcStructure(content: string, filePath: string): StructureResult | null {
  if (!isTsLikePath(filePath)) return null;
  if (Buffer.byteLength(content, "utf8") > OXC_MAX_BYTES) return null;

  const result: StructureResult = {
    imports: [],
    exports: [],
    functions: [],
    classes: [],
    types: [],
    constants: [],
  };

  try {
    const program = oxcParseProgram(filePath, content);
    if (!program) return null;
    for (const stmt of program.body) {
      switch (stmt.type) {
        case "ImportDeclaration": {
          const imp = stmt as { source?: { value?: string } };
          const src = typeof imp.source?.value === "string" ? imp.source.value : "";
          if (src) result.imports.push(src);
          break;
        }
        case "FunctionDeclaration": {
          const fd = stmt as { id?: { name?: string } };
          if (fd.id?.name) result.functions.push(fd.id.name);
          break;
        }
        case "ClassDeclaration": {
          const cd = stmt as { id?: { name?: string } };
          if (cd.id?.name) result.classes.push(cd.id.name);
          break;
        }
        case "ExportNamedDeclaration": {
          const exp = stmt as {
            declaration?: { type?: string; id?: { name?: string } };
            specifiers?: Array<{ type?: string; exported?: { type?: string; name?: string } }>;
          };
          if (exp.declaration?.type === "FunctionDeclaration" && exp.declaration.id?.name) {
            result.exports.push(exp.declaration.id.name);
          } else if (exp.declaration?.type === "ClassDeclaration" && exp.declaration.id?.name) {
            result.exports.push(exp.declaration.id.name);
          } else if (exp.specifiers) {
            for (const s of exp.specifiers) {
              if (
                s.type === "ExportSpecifier" &&
                s.exported?.type === "Identifier" &&
                s.exported.name
              ) {
                result.exports.push(s.exported.name);
              }
            }
          }
          break;
        }
        case "VariableDeclaration": {
          const vd = stmt as {
            declarations: Array<{
              id: { type?: string; name?: string };
              init?: { type?: string };
            }>;
          };
          for (const d of vd.declarations) {
            if (d.id.type === "Identifier" && d.id.name && d.init) {
              if (
                d.init.type === "ArrowFunctionExpression" ||
                d.init.type === "FunctionExpression"
              ) {
                result.functions.push(d.id.name);
              }
            }
          }
          break;
        }
        default:
          break;
      }
    }
    return result;
  } catch {
    return null;
  }
}

function regexStructure(content: string): StructureResult {
  const result: StructureResult = {
    imports: [],
    exports: [],
    functions: [],
    classes: [],
  };
  const importRe = /import\s+.*?\s+from\s+['"]([^'"]+)['"]/g;
  const exportRe = /export\s+(?:async\s+)?(?:function|class|const|let|var)\s+(\w+)/g;
  const fnRe = /(?:export\s+)?(?:async\s+)?function\s+(\w+)/g;
  const classRe = /(?:export\s+)?class\s+(\w+)/g;
  let m: RegExpExecArray | null;
  while ((m = importRe.exec(content)) !== null) result.imports.push(m[1]);
  while ((m = exportRe.exec(content)) !== null) result.exports.push(m[1]);
  while ((m = fnRe.exec(content)) !== null) result.functions.push(m[1]);
  while ((m = classRe.exec(content)) !== null) result.classes.push(m[1]);
  return result;
}

export async function parseFileStructure(
  filePath: string,
  _extract: ("imports" | "exports" | "functions" | "classes" | "types" | "constants")[] = [
    "imports",
    "exports",
    "functions",
    "classes",
  ],
  _options?: { workspacePath?: string; relativePath?: string },
): Promise<StructureResult | null> {
  let content: string;
  try {
    content = await fs.readFile(filePath, "utf-8");
  } catch {
    return null;
  }
  const oxc = walkOxcStructure(content, filePath);
  if (oxc) return oxc;
  if (isTsLikePath(filePath)) return regexStructure(content);
  return null;
}

export async function parseFileStructureBatch(
  filePaths: string[],
  extract: ("imports" | "exports" | "functions" | "classes" | "types" | "constants")[] = [
    "imports",
    "exports",
    "functions",
    "classes",
  ],
): Promise<Record<string, StructureResult>> {
  const results: Record<string, StructureResult> = {};
  for (const filePath of filePaths) {
    const result = await parseFileStructure(filePath, extract);
    if (result) results[filePath] = result;
  }
  return results;
}
