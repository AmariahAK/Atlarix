/**
 * Blueprint as RAG: query graph for relevant node ids, then retrieve code snippets for LLM context.
 */

import * as fs from "fs/promises";
import * as path from "path";
import type { BlueprintNode, RTEBlueprintEdge } from "./rte/parsers/types";

export interface CodeSnippet {
  nodeId: string;
  path: string;
  line: number;
  language: string;
  content: string;
}

/** Minimal graph shape for querying (RTE result or compatible) */
export interface BlueprintGraph {
  nodes: Array<{ id: string; name: string; file: string; line?: number; description?: string; path?: string }>;
  edges: Array<{ from: string; to: string }>;
}

/**
 * Find node ids relevant to a natural language query.
 * Uses keyword match on node name/description and optional 1-hop edge traversal.
 */
export function queryBlueprint(blueprint: BlueprintGraph, query: string): string[] {
  const q = query.toLowerCase();
  const words = q.split(/\s+/).filter((w) => w.length > 2);
  const matched = new Set<string>();

  for (const node of blueprint.nodes) {
    const text = [node.name, node.description, node.path].filter(Boolean).join(" ").toLowerCase();
    if (words.some((w) => text.includes(w))) {
      matched.add(node.id);
    }
  }

  for (const id of matched) {
    for (const e of blueprint.edges) {
      if (e.from === id) matched.add(e.to);
      if (e.to === id) matched.add(e.from);
    }
  }

  return Array.from(matched);
}

const EXT_TO_LANG: Record<string, string> = {
  ".ts": "typescript", ".tsx": "typescript", ".js": "javascript", ".jsx": "javascript",
  ".py": "python", ".go": "go", ".rs": "rust", ".java": "java", ".cs": "csharp",
  ".rb": "ruby", ".php": "php", ".md": "markdown", ".json": "json",
};

/**
 * Read code for the given nodes and return snippets (with context lines).
 * projectPath is the project root; node.file is relative to it.
 */
export async function getCodeForNodes(
  blueprint: BlueprintGraph,
  nodeIds: string[],
  projectPath: string,
  contextLines = 5
): Promise<CodeSnippet[]> {
  const idSet = new Set(nodeIds);
  const nodes = blueprint.nodes.filter((n) => idSet.has(n.id));
  const snippets: CodeSnippet[] = [];

  for (const node of nodes) {
    const filePath = path.join(projectPath, node.file);
    let content: string;
    try {
      content = await fs.readFile(filePath, "utf-8");
    } catch {
      continue;
    }
    const line = node.line ?? 1;
    const lines = content.split("\n");
    const start = Math.max(0, line - 1 - contextLines);
    const end = Math.min(lines.length, line + contextLines);
    const slice = lines.slice(start, end).join("\n");
    const ext = path.extname(node.file).toLowerCase();
    snippets.push({
      nodeId: node.id,
      path: node.file,
      line: line,
      language: EXT_TO_LANG[ext] ?? "text",
      content: slice,
    });
  }

  return snippets;
}
