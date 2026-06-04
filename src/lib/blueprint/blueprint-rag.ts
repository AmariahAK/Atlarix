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

