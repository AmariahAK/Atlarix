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
const IMPORT_JAVA_KT = /^\s*import\s+([a-zA-Z0-9_.]+)\s*;?/gm;
const IMPORT_GO = /^\s*import\s+(?:\(\s*)?(?:"([^"]+)"|`([^`]+)`|'([^']+)')/gm;
const IMPORT_RUST_USE = /^\s*use\s+([a-zA-Z0-9_:]+)\s*;?/gm;
const IMPORT_RUST_MOD = /^\s*mod\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*;?/gm;
const IMPORT_CSHARP = /^\s*using\s+([a-zA-Z0-9_.]+)\s*;?/gm;
const IMPORT_RUBY = /^\s*require(?:_relative)?\s+["']([^"']+)["']/gm;
const IMPORT_PHP_USE = /^\s*use\s+([A-Za-z0-9_\\]+)\s*;?/gm;
const IMPORT_PHP_INCLUDE = /^\s*(?:require|require_once|include|include_once)\s*\(?\s*["']([^"']+)["']\s*\)?\s*;?/gm;
const IMPORT_SWIFT = /^\s*import\s+([A-Za-z_][A-Za-z0-9_]*)/gm;
const IMPORT_ELIXIR = /^\s*(?:alias|import|use)\s+([A-Za-z_][A-Za-z0-9_.]*)/gm;

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
  let m: RegExpExecArray | null;
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

  if (language === "java" || language === "kotlin") {
    // Best-effort intra-repo import edges: match imported class simple names against node names.
    const globalIdByName = new Map<string, string>();
    for (const n of nodes) {
      if (!globalIdByName.has(n.name)) globalIdByName.set(n.name, n.id);
    }
    for (const [relPath, fileNodes] of nodesByFile) {
      const absPath = path.join(projectPath, relPath);
      let content: string;
      try {
        content = await fs.readFile(absPath, "utf-8");
      } catch {
        continue;
      }
      const seen = new Set<string>();
      IMPORT_JAVA_KT.lastIndex = 0;
      while ((m = IMPORT_JAVA_KT.exec(content)) !== null) {
        const fqn = m[1];
        if (!fqn) continue;
        const simple = fqn.split(".").slice(-1)[0];
        const toId = globalIdByName.get(simple);
        if (!toId) continue;
        const fromId = fileNodes[0]?.id;
        if (!fromId || fromId === toId) continue;
        const key = `${fromId}->${toId}`;
        if (seen.has(key)) continue;
        seen.add(key);
        edges.push({ from: fromId, to: toId, type: "imports", label: "import" });
      }
    }
  }

  if (
    language === "go" ||
    language === "rust" ||
    language === "csharp" ||
    language === "ruby" ||
    language === "php" ||
    language === "swift" ||
    language === "elixir"
  ) {
    const globalIdByName = new Map<string, string>();
    for (const n of nodes) {
      if (!globalIdByName.has(n.name)) globalIdByName.set(n.name, n.id);
    }

    for (const [relPath, fileNodes] of nodesByFile) {
      const absPath = path.join(projectPath, relPath);
      let content: string;
      try {
        content = await fs.readFile(absPath, "utf-8");
      } catch {
        continue;
      }
      const fromId = fileNodes[0]?.id;
      if (!fromId) continue;

      const seen = new Set<string>();
      const addEdge = (toId: string, label: string) => {
        if (fromId === toId) return;
        const key = `${fromId}->${toId}`;
        if (seen.has(key)) return;
        if (seen.size >= 30) return;
        seen.add(key);
        edges.push({ from: fromId, to: toId, type: "imports", label });
      };

      if (language === "go") {
        IMPORT_GO.lastIndex = 0;
        while ((m = IMPORT_GO.exec(content)) !== null) {
          const pkg = m[1] ?? m[2] ?? m[3];
          if (!pkg) continue;
          const simple = pkg.split("/").slice(-1)[0];
          const toId = globalIdByName.get(simple);
          if (toId) addEdge(toId, "import");
        }
      }

      if (language === "rust") {
        IMPORT_RUST_USE.lastIndex = 0;
        while ((m = IMPORT_RUST_USE.exec(content)) !== null) {
          const raw = m[1];
          if (!raw) continue;
          const simple = raw.split("::").slice(-1)[0];
          const toId = globalIdByName.get(simple);
          if (toId) addEdge(toId, "use");
        }

        IMPORT_RUST_MOD.lastIndex = 0;
        while ((m = IMPORT_RUST_MOD.exec(content)) !== null) {
          const mod = m[1];
          if (!mod) continue;
          const toId = globalIdByName.get(mod);
          if (toId) addEdge(toId, "mod");
        }
      }

      if (language === "csharp") {
        IMPORT_CSHARP.lastIndex = 0;
        while ((m = IMPORT_CSHARP.exec(content)) !== null) {
          const ns = m[1];
          if (!ns) continue;
          const simple = ns.split(".").slice(-1)[0];
          const toId = globalIdByName.get(simple);
          if (toId) addEdge(toId, "using");
        }
      }

      if (language === "ruby") {
        IMPORT_RUBY.lastIndex = 0;
        while ((m = IMPORT_RUBY.exec(content)) !== null) {
          const raw = m[1];
          if (!raw) continue;

          // Best-effort: if it's a relative require, try resolving to a local file.
          const isRelative = raw.startsWith(".") || raw.startsWith("/");
          if (isRelative) {
            const fromDir = path.dirname(relPath);
            const resolved = path
              .normalize(path.join(fromDir, raw))
              .replace(/\\/g, "/")
              .replace(/\.rb$/, "");
            const targetNodes = nodesByFile.get(resolved + ".rb") ?? nodesByFile.get(resolved);
            const toId = targetNodes?.[0]?.id;
            if (toId) addEdge(toId, "require");
            continue;
          }

          // Otherwise, only link if a node name matches.
          const simple = raw.split("/").slice(-1)[0];
          const toId = globalIdByName.get(simple);
          if (toId) addEdge(toId, "require");
        }
      }

      if (language === "php") {
        IMPORT_PHP_USE.lastIndex = 0;
        while ((m = IMPORT_PHP_USE.exec(content)) !== null) {
          const fqn = m[1];
          if (!fqn) continue;
          const simple = fqn.split("\\").slice(-1)[0];
          const toId = globalIdByName.get(simple);
          if (toId) addEdge(toId, "use");
        }

        IMPORT_PHP_INCLUDE.lastIndex = 0;
        while ((m = IMPORT_PHP_INCLUDE.exec(content)) !== null) {
          const raw = m[1];
          if (!raw) continue;
          const resolved = resolveImportPath(raw, relPath);
          if (!resolved) continue;
          const targetNodes = nodesByFile.get(resolved) ?? nodesByFile.get(resolved + ".php");
          const toId = targetNodes?.[0]?.id;
          if (toId) addEdge(toId, "include");
        }
      }

      if (language === "swift") {
        IMPORT_SWIFT.lastIndex = 0;
        while ((m = IMPORT_SWIFT.exec(content)) !== null) {
          const mod = m[1];
          if (!mod) continue;
          const toId = globalIdByName.get(mod);
          if (toId) addEdge(toId, "import");
        }
      }

      if (language === "elixir") {
        IMPORT_ELIXIR.lastIndex = 0;
        while ((m = IMPORT_ELIXIR.exec(content)) !== null) {
          const mod = m[1];
          if (!mod) continue;
          const simple = mod.split(".").slice(-1)[0];
          const toId = globalIdByName.get(simple) ?? globalIdByName.get(mod);
          if (toId) addEdge(toId, "alias");
        }
      }
    }
  }

  return edges;
}
