/**
 * WASM tree-sitter extraction for Python, Go, Rust + merge rules with regex.
 *
 * Merge precedence (same as oxc-extract):
 * 1. Primary key: `${relPath}:${kind}:${normalizedName}`
 * 2. WASM wins for function | class
 * 3. Regex wins for route / framework handlers
 * 4. Imports: WASM feature nodes use import: prefix
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { Language, Parser, type Node } from "web-tree-sitter";
import type { BlueprintNode } from "./types";
import { mergeBlueprintNodes } from "./oxc-extract";

export type WasmLang = "python" | "go" | "rust";

let initPromise: Promise<void> | null = null;
const languageCache = new Map<WasmLang, Language>();

function safeId(prefix: string, file: string, name: string, index: number): string {
  return `${prefix}_${file.replace(/[^a-zA-Z0-9]/g, "_")}_${name}_${index}`;
}

export function resolveWasmGrammarPath(lang: WasmLang): string {
  const fileName = `tree-sitter-${lang}.wasm`;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { app } = require("electron") as {
      app?: { isPackaged?: boolean; getAppPath?: () => string };
    };
    if (app?.isPackaged) {
      const packaged = path.join(process.resourcesPath, fileName);
      if (fs.existsSync(packaged)) return packaged;
    }
    if (app?.getAppPath) {
      const dev = path.join(
        app.getAppPath(),
        "node_modules/tree-sitter-wasms/out",
        fileName,
      );
      if (fs.existsSync(dev)) return dev;
    }
  } catch {
    /* vitest / non-electron */
  }
  return path.join(process.cwd(), "node_modules/tree-sitter-wasms/out", fileName);
}

async function ensureParserInit(): Promise<void> {
  if (!initPromise) initPromise = Parser.init();
  await initPromise;
}

async function loadLanguage(lang: WasmLang): Promise<Language> {
  const hit = languageCache.get(lang);
  if (hit) return hit;
  await ensureParserInit();
  const wasmPath = resolveWasmGrammarPath(lang);
  const language = await Language.load(wasmPath);
  languageCache.set(lang, language);
  return language;
}

function childIdentifier(node: Node): string | null {
  for (let i = 0; i < node.childCount; i++) {
    const c = node.child(i);
    if (!c) continue;
    if (c.type === "identifier" || c.type === "type_identifier") return c.text;
    if (c.type === "name") return c.text;
  }
  const nameNode = node.childForFieldName("name");
  return nameNode?.text ?? null;
}

function walkTree(
  node: Node,
  lang: WasmLang,
  relPath: string,
  nodes: BlueprintNode[],
  idRef: { idx: number },
  push: (n: Omit<BlueprintNode, "id" | "file">) => void,
): void {
  const line = node.startPosition.row + 1;

  if (lang === "python") {
    if (node.type === "function_definition") {
      const name = childIdentifier(node) ?? "anonymous";
      push({ type: "function", name, line });
    } else if (node.type === "class_definition") {
      const name = childIdentifier(node) ?? "Anonymous";
      push({ type: "class", name, line });
    } else if (node.type === "import_statement" || node.type === "import_from_statement") {
      push({
        type: "feature",
        name: `import:${node.text.slice(0, 80)}`,
        line,
        description: node.text.trim().slice(0, 120),
      });
    } else if (node.type === "decorated_definition") {
      for (let i = 0; i < node.childCount; i++) {
        const c = node.child(i);
        if (c) walkTree(c, lang, relPath, nodes, idRef, push);
      }
    }
  }

  if (lang === "go") {
    if (node.type === "function_declaration") {
      const name = childIdentifier(node) ?? "anonymous";
      push({ type: "function", name, line });
    } else if (node.type === "method_declaration") {
      const name = childIdentifier(node) ?? "method";
      const recv = node.childForFieldName("receiver")?.text ?? "";
      push({
        type: "function",
        name,
        line,
        description: recv ? `receiver ${recv}` : undefined,
      });
    } else if (node.type === "type_declaration") {
      for (let i = 0; i < node.childCount; i++) {
        const spec = node.child(i);
        if (spec?.type === "type_spec") {
          const name = childIdentifier(spec) ?? "type";
          push({ type: "class", name, line: spec.startPosition.row + 1 });
        }
      }
    } else if (node.type === "import_declaration") {
      push({
        type: "feature",
        name: `import:${node.text.slice(0, 60)}`,
        line,
        description: node.text.trim().slice(0, 100),
      });
    }
  }

  if (lang === "rust") {
    if (node.type === "function_item") {
      const name = childIdentifier(node) ?? "anonymous";
      push({ type: "function", name, line });
    } else if (
      node.type === "struct_item" ||
      node.type === "enum_item" ||
      node.type === "trait_item"
    ) {
      const name = childIdentifier(node) ?? node.type;
      push({ type: "class", name, line });
    } else if (node.type === "impl_item") {
      const name = childIdentifier(node) ?? "impl";
      push({ type: "class", name, line, description: "impl block" });
    } else if (node.type === "mod_item") {
      const name = childIdentifier(node) ?? "mod";
      push({ type: "class", name, line, description: "module" });
    } else if (node.type === "use_declaration") {
      push({
        type: "feature",
        name: `import:${node.text.slice(0, 60)}`,
        line,
        description: node.text.trim().slice(0, 100),
      });
    }
  }

  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child) walkTree(child, lang, relPath, nodes, idRef, push);
  }
}

/**
 * Parse source with tree-sitter WASM. Returns [] on any error (caller uses regex fallback).
 */
export async function extractWithWasm(
  source: string,
  lang: WasmLang,
  relPath: string,
  idOffset: number,
): Promise<BlueprintNode[]> {
  try {
    const language = await loadLanguage(lang);
    const parser = new Parser();
    parser.setLanguage(language);
    const tree = parser.parse(source);
    if (!tree) return [];

    const nodes: BlueprintNode[] = [];
    const idRef = { idx: idOffset };
    const push = (n: Omit<BlueprintNode, "id" | "file">) => {
      const id = safeId("wasm", relPath, n.name, idRef.idx++);
      nodes.push({ ...n, id, file: relPath });
    };

    walkTree(tree.rootNode, lang, relPath, nodes, idRef, push);
    return nodes;
  } catch {
    return [];
  }
}

export function mergeWasmWithRegex(
  wasmNodes: BlueprintNode[],
  regexNodes: BlueprintNode[],
): BlueprintNode[] {
  return mergeBlueprintNodes(wasmNodes, regexNodes);
}
