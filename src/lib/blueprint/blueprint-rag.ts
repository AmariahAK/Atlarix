/**
 * Blueprint as RAG: query graph for relevant node ids, then retrieve code snippets for LLM context.
 */

import * as fs from "fs/promises";
import * as path from "path";
import type { Blueprint } from "@/shared/blueprint-types";
import log from "electron-log";

const logger = log.scope("blueprint-rag");

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

export interface NodeLineRange {
  rangeStart?: number;
  rangeEnd?: number;
}

function relPathForBeacon(
  projectRoot: string,
  file: string | undefined,
  description: string | undefined,
): string {
  const normRoot = path.normalize(projectRoot).replace(/\\/g, "/");
  if (file) {
    const nf = path.normalize(file).replace(/\\/g, "/");
    if (path.isAbsolute(file) && nf.startsWith(normRoot)) {
      return path.relative(projectRoot, file).replace(/\\/g, "/");
    }
    if (!path.isAbsolute(file)) {
      return file.replace(/\\/g, "/");
    }
    return file.replace(/\\/g, "/");
  }
  const d = description?.trim();
  if (d && !d.includes("\n") && /\.[a-zA-Z0-9]+$/.test(d)) {
    const nd = path.normalize(d).replace(/\\/g, "/");
    if (path.isAbsolute(d) && nd.startsWith(normRoot)) {
      return path.relative(projectRoot, d).replace(/\\/g, "/");
    }
    return d.replace(/\\/g, "/");
  }
  return "";
}

/**
 * Build a RAG graph from a Blueprint (rooms + flowEdges).
 * Keeps all beacons for relevance ranking; code snippet retrieval is file-gated later.
 */
export function blueprintToRagGraph(blueprint: Blueprint, projectRoot: string): BlueprintGraph {
  const nodes: BlueprintGraph["nodes"] = [];
  const edges: BlueprintGraph["edges"] = [];

  for (const room of blueprint.rooms ?? []) {
    if (room.hidden) continue;
    for (const f of room.functions ?? []) {
      const rel = relPathForBeacon(projectRoot, f.file, f.description);
      nodes.push({
        id: f.id,
        name: f.name,
        file: rel || "",
        description: f.simpleDescription ?? f.description,
        path: room.path,
      });
    }
    for (const fe of room.flowEdges ?? []) {
      edges.push({ from: fe.from, to: fe.to });
    }
  }

  return { nodes, edges };
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

/**
 * Rank node ids: direct keyword matches first, then 1-hop flow neighbors, then remaining nodes.
 * When the query has no keywords (length > 2), returns all node ids in graph order.
 */
export function rankBlueprintNodeIds(graph: BlueprintGraph, query: string): string[] {
  const q = query.toLowerCase();
  const words = q.split(/\s+/).filter((w) => w.length > 2);
  const primary: string[] = [];
  const primarySet = new Set<string>();

  if (words.length > 0) {
    for (const node of graph.nodes) {
      const text = [node.name, node.description, node.path].filter(Boolean).join(" ").toLowerCase();
      if (words.some((w) => text.includes(w)) && !primarySet.has(node.id)) {
        primary.push(node.id);
        primarySet.add(node.id);
      }
    }
  }

  const neighbor: string[] = [];
  const neighborSet = new Set<string>();
  for (const id of primarySet) {
    for (const e of graph.edges) {
      const other = e.from === id ? e.to : e.to === id ? e.from : null;
      if (other && !primarySet.has(other) && !neighborSet.has(other)) {
        neighbor.push(other);
        neighborSet.add(other);
      }
    }
  }

  const rest: string[] = [];
  for (const node of graph.nodes) {
    if (!primarySet.has(node.id) && !neighborSet.has(node.id)) {
      rest.push(node.id);
    }
  }

  if (words.length === 0) {
    return graph.nodes.map((n) => n.id);
  }
  return [...primary, ...neighbor, ...rest];
}

const EXT_TO_LANG: Record<string, string> = {
  ".ts": "typescript",
  ".tsx": "typescript",
  ".js": "javascript",
  ".jsx": "javascript",
  ".py": "python",
  ".go": "go",
  ".rs": "rust",
  ".java": "java",
  ".cs": "csharp",
  ".rb": "ruby",
  ".php": "php",
  ".md": "markdown",
  ".json": "json",
};

const BUFFER_LINES = 5;
const MAX_SNIPPET_LINES = 150;
const HALF_WINDOW = 75;
const FALLBACK_HALF = 25; // ~50 lines total

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function sliceLinesWithTruncation(
  lines: string[],
  start0: number,
  end0: number,
): string {
  const start = Math.max(0, start0);
  const end = Math.min(lines.length, end0);
  const span = end - start;
  if (span <= MAX_SNIPPET_LINES) {
    return lines.slice(start, end).join("\n");
  }
  const first = lines.slice(start, start + HALF_WINDOW).join("\n");
  const last = lines.slice(end - HALF_WINDOW, end).join("\n");
  return `${first}\n\n// ... truncated ...\n\n${last}`;
}

function findFallbackCenterLine(content: string, name: string): number {
  const lines = content.split("\n");
  const patterns = [
    new RegExp(`\\bfunction\\s+${escapeRegExp(name)}\\b`),
    new RegExp(`\\b${escapeRegExp(name)}\\s*[=:]\\s*\\(`),
    new RegExp(`\\bclass\\s+${escapeRegExp(name)}\\b`),
    new RegExp(`\\bdef\\s+${escapeRegExp(name)}\\b`),
    new RegExp(`\\b${escapeRegExp(name)}\\b`),
  ];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (patterns.some((re) => re.test(line))) return i + 1;
  }
  return 1;
}

/**
 * Single-node snippet for Build tier (same logic as batch helper).
 */
export async function getCodeSnippetForBuildNode(
  graph: BlueprintGraph,
  nodeId: string,
  projectPath: string,
  rangesByNodeId: Map<string, NodeLineRange>,
): Promise<CodeSnippet | null> {
  const node = graph.nodes.find((n) => n.id === nodeId);
  if (!node) return null;
  if (!node.file) return null;
  const filePath = path.isAbsolute(node.file) ? node.file : path.join(projectPath, node.file);
  let content: string;
  try {
    content = await fs.readFile(filePath, "utf-8");
  } catch {
    return null;
  }
  const lines = content.split("\n");
  const ext = path.extname(node.file).toLowerCase();
  const lang = EXT_TO_LANG[ext] ?? "text";

  const range = rangesByNodeId.get(node.id);
  const hasRange =
    range &&
    typeof range.rangeStart === "number" &&
    range.rangeStart > 0 &&
    typeof range.rangeEnd === "number" &&
    range.rangeEnd >= range.rangeStart;

  if (hasRange) {
    const start0 = range!.rangeStart! - 1 - BUFFER_LINES;
    const end0 = range!.rangeEnd! + BUFFER_LINES;
    const slice = sliceLinesWithTruncation(lines, start0, end0);
    return {
      nodeId: node.id,
      path: node.file,
      line: range!.rangeStart!,
      language: lang,
      content: slice,
    };
  }

  logger.warn(`Missing PIVOT line range for node ${node.id}; using name-search fallback (${node.file})`);
  const center = findFallbackCenterLine(content, node.name);
  const start0 = Math.max(0, center - 1 - FALLBACK_HALF);
  const end0 = Math.min(lines.length, center + FALLBACK_HALF);
  const slice = lines.slice(start0, end0).join("\n");
  return {
    nodeId: node.id,
    path: node.file,
    line: center,
    language: lang,
    content: slice,
  };
}

/**
 * Read code for the given nodes and return snippets (with context lines).
 * projectPath is the project root; node.file is relative to it.
 */
export async function getCodeForNodes(
  blueprint: BlueprintGraph,
  nodeIds: string[],
  projectPath: string,
  contextLines = 5,
): Promise<CodeSnippet[]> {
  const idSet = new Set(nodeIds);
  const nodes = blueprint.nodes.filter((n) => idSet.has(n.id));
  const snippets: CodeSnippet[] = [];

  for (const node of nodes) {
    const filePath = path.isAbsolute(node.file) ? node.file : path.join(projectPath, node.file);
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

/**
 * Build-tier snippets: prefer PIVOT line ranges; fallback to name search (~50-line window) or file head.
 */
export async function getCodeSnippetsForBuildTier(
  blueprint: BlueprintGraph,
  nodeIds: string[],
  projectPath: string,
  rangesByNodeId: Map<string, NodeLineRange>,
): Promise<CodeSnippet[]> {
  const snippets: CodeSnippet[] = [];
  for (const id of nodeIds) {
    const sn = await getCodeSnippetForBuildNode(blueprint, id, projectPath, rangesByNodeId);
    if (sn) snippets.push(sn);
  }
  return snippets;
}
