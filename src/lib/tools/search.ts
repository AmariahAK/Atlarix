/**
 * Atlarix unified `search` tool.
 *
 * Routes a single tool to engines:
 *   - text (ripgrep)
 *   - semantic-lite (line relevance scan, no blueprint)
 *   - semantic-graph (BM25 over blueprint beacons, then line-scan fallback)
 *   - structural (Blueprint graph via lazy parse)
 *
 * Legacy `mode: "semantic"` is treated as `semantic-graph`.
 * `mode: "auto"` never selects semantic-graph (BM25); use explicit semantic-graph when needed.
 *
 * Absorbs: search-intelligence-tools + _search-helpers (inlined as
 * file-private helpers; no external consumers).
 */

import fs from "fs/promises";
import * as path from "path";
import { exec } from "child_process";
import { promisify } from "util";
import {
  ToolRegistry,
  ToolCategory,
  createParameters,
  stringParam,
  enumParam,
  numberParam,
} from "./registry";
import {
  resolveWorkspaceIdFromRoot,
  searchBlueprintBm25,
} from "@/lib/search/bm25_semantic_index";
import { ensureBlueprintParsed } from "@/lib/blueprint/lazy-parse";
import {
  type SearchModeInput,
  type SearchResolvedMode,
  normalizeRequestedSearchMode,
  resolveSearchMode,
  searchEngineLabel,
} from "@/lib/search/search-mode-routing";

const execAsync = promisify(exec);

// ═══════════════════════════════════════════════════════════
// SEARCH HELPERS (formerly _search-helpers.ts)
// ═══════════════════════════════════════════════════════════

type SemanticSearchLineResult = {
  file: string;
  line: number;
  content: string;
  score: number;
  contextBefore: string[];
  contextAfter: string[];
};

const STOP_WORDS = new Set([
  "the", "a", "an", "in", "on", "at", "to", "for", "of", "with",
  "where", "is", "are", "find", "get", "show", "me", "my", "that", "this",
  "and", "or", "it", "can", "how", "what", "which", "from", "by",
]);

function extractKeywords(query: string): string[] {
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter((word) => word.length > 2 && !STOP_WORDS.has(word));
}

function calculateRelevance(line: string, keywords: string[]): number {
  let score = 0;
  const lowerLine = line.toLowerCase();
  keywords.forEach((keyword) => {
    if (lowerLine.includes(keyword)) {
      score += 1;
      if (new RegExp(`\\b${keyword}\\b`).test(lowerLine)) {
        score += 0.5;
      }
    }
  });
  return score;
}

const CODE_EXTS = [".ts", ".tsx", ".js", ".jsx", ".py", ".java", ".go", ".rs"];

async function getAllCodeFiles(dir: string): Promise<string[]> {
  const files: string[] = [];

  async function scan(directory: string) {
    let entries: any[];
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(directory, entry.name);
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      if (entry.isDirectory()) {
        await scan(fullPath);
      } else if (CODE_EXTS.some((ext) => entry.name.endsWith(ext))) {
        files.push(fullPath);
      }
    }
  }

  await scan(dir);
  return files;
}

async function runSemanticSearchFileFallback(options: {
  workspace: string;
  maxResults: number;
  keywords: string[];
}): Promise<{ results: SemanticSearchLineResult[]; total_matches: number; files_searched: number }> {
  const { workspace, maxResults, keywords } = options;
  const results: SemanticSearchLineResult[] = [];
  const files = await getAllCodeFiles(workspace);

  const { assertReadablePath } = await import("@/lib/security/env-secret-paths");
  for (const file of files) {
    try {
      const rel = path.relative(workspace, file);
      assertReadablePath(rel, workspace);
      const content = await fs.readFile(file, "utf-8");
      const lines = content.split("\n");
      lines.forEach((line, index) => {
        const relevanceScore = calculateRelevance(line, keywords);
        if (relevanceScore > 0) {
          results.push({
            file,
            line: index + 1,
            content: line.trim(),
            score: relevanceScore,
            contextBefore: lines.slice(Math.max(0, index - 3), index),
            contextAfter: lines.slice(index + 1, Math.min(lines.length, index + 4)),
          });
        }
      });
    } catch {
      /* skip unreadable */
    }
  }

  results.sort((a, b) => b.score - a.score);
  return {
    results: results.slice(0, maxResults),
    total_matches: results.length,
    files_searched: files.length,
  };
}

type GrepGroup = { file: string; matches: { line: number; content: string }[] };

function parseGrepOutput(output: string): GrepGroup[] {
  const groups: GrepGroup[] = [];
  const lines = output.split("\n");
  let current: GrepGroup | null = null;

  for (const line of lines) {
    if (!line.includes(":")) continue;
    const [file, lineNum, ...content] = line.split(":");
    const num = parseInt(lineNum, 10);
    if (!file || !lineNum || isNaN(num)) continue;

    if (current && current.file !== file) {
      groups.push(current);
      current = null;
    }
    if (!current) current = { file, matches: [] };
    current.matches.push({ line: num, content: content.join(":").trim() });
  }
  if (current) groups.push(current);
  return groups;
}

function truncateUtf8ByBytes(text: string, maxBytes: number): string {
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= maxBytes) return text;
  const cut = buf.subarray(0, Math.max(0, maxBytes - 100));
  return (
    cut.toString("utf8") +
    "\n\n… [search output truncated by max_bytes; narrow path or lower max_results]"
  );
}

async function runRipgrepSearch(args: {
  pattern: string;
  workspace: string;
  contextLines: number;
  filePattern?: string;
  caseSensitive: boolean;
}): Promise<GrepGroup[]> {
  const { pattern, workspace, contextLines, filePattern, caseSensitive } = args;
  const caseFlag = caseSensitive ? "" : "-i";
  const escaped = pattern.replace(/"/g, '\\"');
  let command = `rg "${escaped}" "${workspace}" -n -C ${contextLines} ${caseFlag}`;
  if (filePattern) command += ` -g "${filePattern}"`;

  try {
    const { stdout } = await execAsync(command, { maxBuffer: 10 * 1024 * 1024 });
    return parseGrepOutput(stdout);
  } catch {
    return [];
  }
}

async function searchCodeByText(args: {
  query: string;
  workspace: string;
  isRegex?: boolean;
  caseSensitive?: boolean;
  contextLines?: number;
  filePattern?: string;
  maxResults?: number;
}): Promise<GrepGroup[]> {
  const {
    query,
    workspace,
    isRegex = false,
    caseSensitive = false,
    contextLines = 2,
    filePattern,
    maxResults = 50,
  } = args;
  const pattern = isRegex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const groups = await runRipgrepSearch({
    pattern,
    workspace,
    contextLines: Math.min(Math.max(0, contextLines), 10),
    filePattern,
    caseSensitive,
  });

  let kept = 0;
  const trimmed: GrepGroup[] = [];
  for (const g of groups) {
    if (kept >= maxResults) break;
    const slice = g.matches.slice(0, Math.max(0, maxResults - kept));
    trimmed.push({ file: g.file, matches: slice });
    kept += slice.length;
  }
  return trimmed;
}

function formatGrepGroupsForDisplay(
  groups: GrepGroup[],
  query: string,
  opts?: { perFileCap?: number; maxBytes?: number },
): string {
  const perFile = Math.min(100, Math.max(1, opts?.perFileCap ?? 30));
  const maxBytes = Math.min(500_000, Math.max(1024, opts?.maxBytes ?? 120_000));
  if (groups.length === 0) return `No matches for "${query}".`;
  const total = groups.reduce((s, g) => s + g.matches.length, 0);
  let out = `Found ${total} match(es) for "${query}" across ${groups.length} file(s):\n\n`;
  for (const g of groups) {
    out += `📄 ${g.file}\n`;
    for (const m of g.matches.slice(0, perFile)) {
      out += `  ${m.line}: ${m.content}\n`;
    }
    if (g.matches.length > perFile)
      out += `  ... and ${g.matches.length - perFile} more in this file\n`;
    out += "\n";
  }
  return truncateUtf8ByBytes(out, maxBytes);
}

// ═══════════════════════════════════════════════════════════
// BLUEPRINT QUERIES + SEMANTIC ENGINES
// ═══════════════════════════════════════════════════════════

function normalizePath(p: string): string {
  return String(p || "").trim().replace(/\\/g, "/").replace(/\/+/g, "/").replace(/\/$/, "");
}

function pathToRipgrepGlob(scopePath: string | undefined): string | undefined {
  if (!scopePath) return undefined;
  const p = scopePath.replace(/^\//, "").replace(/\\/g, "/");
  if (p.includes("*")) return p;
  if (/\.[a-zA-Z0-9]{1,8}$/.test(p)) return `**/${p}`;
  return `**/${p}/**`;
}

function roomMatchesScope(
  room: { id: string; path?: string; functions?: Array<{ file?: string }> },
  scopePath: string | undefined,
): boolean {
  if (!scopePath) return true;
  const t = normalizePath(scopePath).toLowerCase();
  const rp = normalizePath(room.path ?? "").toLowerCase();
  const fnFile = (room.functions ?? []).some(
    (fn) => normalizePath(fn.file ?? "").toLowerCase() === t,
  );
  return rp === t || rp.startsWith(`${t}/`) || fnFile;
}

async function queryBlueprintByNaturalLanguage(args: {
  query: string;
  workspaceId: number;
  scopePath?: string;
  maxResults: number;
}): Promise<{ summary: string; nodes: unknown[]; edges: unknown[] }> {
  const blueprint = await ensureBlueprintParsed(args.workspaceId);
  const q = args.query.toLowerCase();
  const max = Math.max(1, Math.min(200, args.maxResults));

  const matchedRooms = blueprint.rooms.filter((r) => {
    if (!roomMatchesScope(r, args.scopePath)) return false;
    const hay = `${r.label} ${r.intent ?? ""} ${r.path ?? ""}`.toLowerCase();
    return hay.includes(q) || (r.functions ?? []).some((fn) => fn.name.toLowerCase().includes(q));
  });

  const keepIds = new Set(matchedRooms.map((r) => r.id));
  for (const e of blueprint.edges ?? []) {
    if (keepIds.has(e.from) || keepIds.has(e.to)) {
      keepIds.add(e.from);
      keepIds.add(e.to);
    }
  }

  const nodes = blueprint.rooms
    .filter((r) => keepIds.has(r.id))
    .slice(0, max)
    .map((r) => ({
      id: r.id,
      label: r.label,
      type: r.type,
      path: r.path,
      intent: r.intent,
      functions: (r.functions ?? []).slice(0, 20).map((fn) => ({
        id: fn.id,
        name: fn.name,
        kind: fn.kind,
        file: fn.file,
      })),
    }));

  const edges = (blueprint.edges ?? [])
    .filter((e) => keepIds.has(e.from) && keepIds.has(e.to))
    .slice(0, max * 2)
    .map((e) => ({
      from: e.from,
      to: e.to,
      label: e.label,
      type: e.type,
      inferred: e.inferred,
    }));

  const summary =
    nodes.length === 0
      ? `No Blueprint rooms matched "${args.query}"${args.scopePath ? ` under ${args.scopePath}` : ""}. Try a broader query or call get_blueprint with scope=file/folder.`
      : `Structural search matched ${nodes.length} room(s) and ${edges.length} edge(s) for "${args.query}".`;

  return { summary, nodes, edges };
}

function formatSemanticHitsAsText(
  ws: string,
  topResults: Array<{
    file: string;
    line: number;
    content: string;
    score: number;
    contextBefore?: string[];
    contextAfter?: string[];
  }>,
): string {
  return topResults
    .map((r) => {
      const relPath = ws ? path.relative(ws, r.file) : path.basename(r.file);
      const ctxBefore = r.contextBefore || [];
      const ctxAfter = r.contextAfter || [];
      const lineNum = r.line;
      const block = [
        ...ctxBefore.map((l: string, i: number) => `  ${lineNum - ctxBefore.length + i}| ${l}`),
        `> ${lineNum}| ${r.content}`,
        ...ctxAfter.map((l: string, i: number) => `  ${lineNum + i + 1}| ${l}`),
      ].join("\n");
      return `${relPath}:${lineNum}\n${block}`;
    })
    .join("\n\n---\n\n");
}

/** Semantic-lite: keyword relevance scan over source files only (no blueprint / BM25). */
async function searchSemanticLite(args: {
  query: string;
  workspacePath: string;
  scopePath?: string;
  maxResults: number;
}): Promise<string> {
  const ws = path.isAbsolute(args.workspacePath)
    ? path.normalize(args.workspacePath)
    : path.resolve(process.cwd(), args.workspacePath);
  const limit = Math.min(200, Math.max(1, args.maxResults));
  let scanRoot = ws;
  if (args.scopePath?.trim()) {
    const rel = args.scopePath.replace(/^\//, "").replace(/\\/g, "/");
    scanRoot = path.join(ws, rel);
  }

  let keywords = extractKeywords(args.query);
  if (keywords.length === 0 && args.query.trim().length > 0) {
    keywords = [args.query.trim().toLowerCase()];
  }

  const fallback = await runSemanticSearchFileFallback({
    workspace: scanRoot,
    maxResults: limit,
    keywords,
  });
  if (fallback.files_searched === 0) {
    return `No code files found under ${scanRoot}.`;
  }
  return formatSemanticHitsAsText(ws, fallback.results) || "No matches found.";
}

/** Semantic-graph: BM25 over blueprint-backed index, then semantic-lite fallback. */
async function searchSemanticGraph(args: {
  query: string;
  workspacePath: string;
  scopePath?: string;
  maxResults: number;
}): Promise<string> {
  const ws = path.isAbsolute(args.workspacePath)
    ? path.normalize(args.workspacePath)
    : path.resolve(process.cwd(), args.workspacePath);
  const limit = Math.min(200, Math.max(1, args.maxResults));

  let keywords = extractKeywords(args.query);
  if (keywords.length === 0 && args.query.trim().length > 0) {
    keywords = [args.query.trim().toLowerCase()];
  }

  try {
    const workspaceId = await resolveWorkspaceIdFromRoot(ws);
    if (workspaceId != null) {
      const bm25 = await searchBlueprintBm25(workspaceId, ws, args.query, limit);
      if (bm25 && bm25.hits.length > 0) {
        return (
          formatSemanticHitsAsText(
            ws,
            bm25.hits.map((h) => ({
              file: h.file,
              line: h.line,
              content: h.content,
              score: h.score,
              contextBefore: h.contextBefore,
              contextAfter: h.contextAfter,
            })),
          ) || "No matches found."
        );
      }
    }
  } catch {
    /* fall through */
  }

  return searchSemanticLite({ ...args, maxResults: limit });
}

// ═══════════════════════════════════════════════════════════
// SEARCH TOOL
// ═══════════════════════════════════════════════════════════

ToolRegistry.register({
  name: "search",
  category: ToolCategory.SEARCH_INTELLIGENCE,
  description:
    `Unified codebase search. Prefer an explicit mode when possible:
- mode "auto" (default): text (ripgrep), semantic-lite (file relevance scan), or structural — never BM25/blueprint index unless you choose semantic-graph or structural.
- mode "text": ripgrep-style matches
- mode "semantic-lite": concept-style scan over source files only (no blueprint parse)
- mode "semantic-graph": BM25 over blueprint-derived beacons, then semantic-lite fallback (may parse blueprint on first use)
- mode "structural": Blueprint graph relationships (lazy-parse on demand)
- Legacy mode "semantic" is treated as semantic-graph.

Examples:
search({ query: "TODO", mode: "text" })
search({ query: "authentication logic", mode: "semantic-lite" })
search({ query: "what calls handleLogin", mode: "structural" })
search({ query: "routing concepts", mode: "auto" })

Parameters:
- query: natural language or exact search term (required)
- mode: "auto" | "text" | "semantic" | "semantic-lite" | "semantic-graph" | "structural"
- path: limit search to a folder or file (workspace-relative)
- max_results: max number of results (default 30, max 200)
- context_lines: ripgrep context lines for text mode (default 2, max 10)
- max_bytes: UTF-8 cap on formatted text for text / semantic modes (default 120000)`,
  cost: 2,
  requiresWorkspace: true,
  isCore: true,
  isReadOnly: true,
  allowInAskMode: true,
  parameters: createParameters(
    {
      query: stringParam("Natural language or exact search term."),
      mode: enumParam(
        "Search engine",
        "auto",
        ["auto", "text", "semantic", "semantic-lite", "semantic-graph", "structural"],
      ),
      path: stringParam("Optional: limit to a folder or file (workspace-relative)."),
      max_results: numberParam("Max results (default 30, max 200).", 30, 1, 200),
      context_lines: numberParam(
        "Lines of context around each text match (default 2, max 10).",
        2,
        0,
        10,
      ),
      max_bytes: numberParam(
        "Max UTF-8 bytes of formatted text output for text / semantic modes (default 120000).",
        120_000,
        4096,
        500_000,
      ),
      workspaceId: { type: "number", description: "Workspace ID (auto-provided)" },
      workspace: { type: "string", description: "Workspace root path (auto-provided)" },
    },
    ["query"],
  ),
  handler: async (params: {
    query: string;
    mode?: SearchModeInput;
    path?: string;
    max_results?: number;
    context_lines?: number;
    max_bytes?: number;
    workspaceId?: number;
    workspace?: string;
    _onSearchRouting?: (detail: string) => void;
  }) => {
    const rawMode = (params.mode ?? "auto") as SearchModeInput;
    const requestedCanonical = normalizeRequestedSearchMode(rawMode);
    const resolvedMode: SearchResolvedMode = resolveSearchMode(requestedCanonical, params.query);
    const engine = searchEngineLabel(resolvedMode);
    const emitRoute = () => {
      try {
        params._onSearchRouting?.(
          `requested=${requestedCanonical} resolved=${resolvedMode} engine=${engine}`,
        );
      } catch {
        /* ignore activity failures */
      }
    };

    const maxResults = Math.min(200, Math.max(1, params.max_results ?? 30));
    const contextLines = Math.min(10, Math.max(0, Number(params.context_lines) || 2));
    const maxBytes = Math.min(500_000, Math.max(4096, Number(params.max_bytes) || 120_000));
    const workspacePath = params.workspace || process.cwd();

    emitRoute();

    try {
      if (resolvedMode === "structural") {
        if (params.workspaceId == null) {
          return {
            success: false,
            error: "search(structural) requires workspaceId.",
            requested_mode: rawMode,
            resolved_mode: resolvedMode,
            engine,
          };
        }
        const graph = await queryBlueprintByNaturalLanguage({
          query: params.query,
          workspaceId: params.workspaceId,
          scopePath: params.path,
          maxResults,
        });
        return {
          success: true,
          requested_mode: rawMode,
          resolved_mode: resolvedMode,
          engine,
          mode: resolvedMode,
          ...graph,
        };
      }

      if (resolvedMode === "semantic-graph") {
        const text = await searchSemanticGraph({
          query: params.query,
          workspacePath,
          scopePath: params.path,
          maxResults,
        });
        return {
          success: true,
          requested_mode: rawMode,
          resolved_mode: resolvedMode,
          engine,
          mode: resolvedMode,
          result: truncateUtf8ByBytes(text, maxBytes),
        };
      }

      if (resolvedMode === "semantic-lite") {
        const text = await searchSemanticLite({
          query: params.query,
          workspacePath,
          scopePath: params.path,
          maxResults,
        });
        return {
          success: true,
          requested_mode: rawMode,
          resolved_mode: resolvedMode,
          engine,
          mode: resolvedMode,
          result: truncateUtf8ByBytes(text, maxBytes),
        };
      }

      const groups = await searchCodeByText({
        query: params.query,
        workspace: workspacePath,
        isRegex: false,
        caseSensitive: false,
        contextLines,
        filePattern: pathToRipgrepGlob(params.path),
        maxResults,
      });
      return {
        success: true,
        requested_mode: rawMode,
        resolved_mode: resolvedMode,
        engine,
        mode: resolvedMode,
        result: formatGrepGroupsForDisplay(groups, params.query, {
          perFileCap: 30,
          maxBytes,
        }),
      };
    } catch (e) {
      return {
        success: false,
        error: e instanceof Error ? e.message : String(e),
        requested_mode: rawMode,
        resolved_mode: resolvedMode,
        engine,
      };
    }
  },
});
