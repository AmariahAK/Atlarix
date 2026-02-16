/**
 * Extract import and call edges from parsed nodes by re-reading source files.
 * Used after language parsers run to populate node.calls and build import edges.
 */

import * as fs from "fs/promises";
import * as path from "path";
import type { BlueprintNode, RTEBlueprintEdge } from "./types";
import type { SupportedLanguage } from "./types";

const IMPORT_TS =
  /(?:import\s+(?:(?:\{[^}]*\}|\*\s+as\s+\w+|\w+)\s+from\s+)?|export\s+(?:\{[^}]*\}\s+from\s+))['"]([^'"]+)['"]|require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
const CALL_PATTERN = /\b([a-zA-Z_$][a-zA-Z0-9_$]*)\s*\(/g;

const IMPORT_PY = /^\s*(?:import\s+(\w+)|from\s+([\w.]+)\s+import\s+)/gm;

function resolveImportPath(importPath: string, fromFile: string): string | null {
  if (importPath.startsWith(".")) {
    const fromDir = path.dirname(fromFile);
    const resolved = path.join(fromDir, importPath);
    return path.normalize(resolved).replace(/\\/g, "/");
  }
  return null;
}

export async function extractImportAndCallEdges(
  projectPath: string,
  nodes: BlueprintNode[],
  language: SupportedLanguage
): Promise<RTEBlueprintEdge[]> {
  const edges: RTEBlueprintEdge[] = [];
  const nodesByFile = new Map<string, BlueprintNode[]>();
  for (const n of nodes) {
    const file = n.file.replace(/\\/g, "/");
    if (!nodesByFile.has(file)) nodesByFile.set(file, []);
    nodesByFile.get(file)!.push(n);
  }

  if (language === "typescript" || language === "javascript") {
    for (const [relPath, fileNodes] of nodesByFile) {
      const absPath = path.join(projectPath, relPath);
      let content: string;
      try {
        content = await fs.readFile(absPath, "utf-8");
      } catch {
        continue;
      }
      const namesInFile = new Set(fileNodes.map((n) => n.name));
      const idByName = new Map<string, string>();
      for (const n of fileNodes) {
        idByName.set(n.name, n.id);
      }

      const seenImportKeys = new Set<string>();
      IMPORT_TS.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = IMPORT_TS.exec(content)) !== null) {
        const raw = m[1] ?? m[2];
        if (!raw || !raw.startsWith(".")) continue;
        const resolved = resolveImportPath(raw, relPath);
        if (!resolved) continue;
        const targetNodes =
          nodesByFile.get(resolved) ??
          nodesByFile.get(resolved + ".ts") ??
          nodesByFile.get(resolved + ".tsx") ??
          nodesByFile.get(resolved + ".js") ??
          nodesByFile.get(resolved + ".jsx");
        if (!targetNodes?.length) continue;
        const key = `${fileNodes[0].id}->${targetNodes[0].id}`;
        if (seenImportKeys.has(key)) continue;
        seenImportKeys.add(key);
        edges.push({
          from: fileNodes[0].id,
          to: targetNodes[0].id,
          type: "imports",
          label: "import",
        });
      }

      for (const node of fileNodes) {
        if (!node.line) continue;
        const lines = content.split("\n");
        const startLine = Math.max(0, node.line - 1);
        let endLine = startLine + 1;
        let depth = 0;
        for (let i = startLine; i < lines.length; i++) {
          const line = lines[i];
          if (i === startLine && (line.includes("=>") || line.includes("function") || line.includes("("))) {
            depth = (line.match(/[{[(]/g)?.length ?? 0) - (line.match(/[}\])]/g)?.length ?? 0);
          } else if (i > startLine) {
            depth += (line.match(/[{[(]/g)?.length ?? 0) - (line.match(/[}\])]/g)?.length ?? 0);
          }
          endLine = i + 1;
          if (depth < 0) break;
        }
        const block = lines.slice(startLine, endLine).join("\n");
        CALL_PATTERN.lastIndex = 0;
        const calls = node.calls ?? [];
        while ((m = CALL_PATTERN.exec(block)) !== null) {
          const name = m[1];
          if (name === "function" || name === "if" || name === "for" || name === "while" || name === "switch" || name === "catch" || name === "super") continue;
          if (namesInFile.has(name)) {
            const toId = idByName.get(name);
            if (toId && toId !== node.id && !calls.includes(toId)) calls.push(toId);
          }
        }
        if (calls.length > 0) node.calls = calls;
      }
    }
  }

  if (language === "python") {
    for (const [relPath, fileNodes] of nodesByFile) {
      const absPath = path.join(projectPath, relPath);
      let content: string;
      try {
        content = await fs.readFile(absPath, "utf-8");
      } catch {
        continue;
      }
      const namesInFile = new Set(fileNodes.map((n) => n.name));
      const idByName = new Map<string, string>();
      for (const n of fileNodes) {
        idByName.set(n.name, n.id);
      }

      const seenImportKeysPy = new Set<string>();
      IMPORT_PY.lastIndex = 0;
      while ((m = IMPORT_PY.exec(content)) !== null) {
        const mod = m[1] ?? m[2];
        if (!mod) continue;
        const resolved = mod.replace(/\./g, "/") + ".py";
        const fromDir = path.dirname(relPath);
        const resolvedPath = path.normalize(path.join(fromDir, resolved)).replace(/\\/g, "/");
        const targetNodes = nodesByFile.get(resolvedPath) ?? nodesByFile.get(resolvedPath.replace(/\.py$/, ""));
        if (!targetNodes?.length) continue;
        const key = `${fileNodes[0].id}->${targetNodes[0].id}`;
        if (seenImportKeysPy.has(key)) continue;
        seenImportKeysPy.add(key);
        edges.push({
          from: fileNodes[0].id,
          to: targetNodes[0].id,
          type: "imports",
          label: "import",
        });
      }

      const FUNC_CALL_PY = /\b([a-zA-Z_][a-zA-Z0-9_]*)\s*\(/g;
      for (const node of fileNodes) {
        if (!node.line) continue;
        const lines = content.split("\n");
        const startLine = Math.max(0, node.line - 1);
        let endLine = startLine + 1;
        let indent = -1;
        for (let i = startLine; i < lines.length; i++) {
          const line = lines[i];
          const lineIndent = line.search(/\S/);
          if (i === startLine) indent = lineIndent;
          else if (lineIndent >= 0 && indent >= 0 && lineIndent <= indent && line.trim().length > 0) break;
          endLine = i + 1;
        }
        const block = lines.slice(startLine, endLine).join("\n");
        FUNC_CALL_PY.lastIndex = 0;
        const calls = node.calls ?? [];
        while ((m = FUNC_CALL_PY.exec(block)) !== null) {
          const name = m[1];
          if (["def", "class", "if", "for", "while", "with", "try", "except", "lambda"].includes(name)) continue;
          if (namesInFile.has(name)) {
            const toId = idByName.get(name);
            if (toId && toId !== node.id && !calls.includes(toId)) calls.push(toId);
          }
        }
        if (calls.length > 0) node.calls = calls;
      }
    }
  }

  return edges;
}
