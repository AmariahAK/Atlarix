/**
 * Pure search mode routing for the unified `search` tool.
 * Kept separate from ToolRegistry so Vitest can import without loading all tools.
 */

/** Modes the model may pass (includes legacy `semantic` → treated as graph). */
export type SearchModeInput =
  | "auto"
  | "text"
  | "semantic"
  | "semantic-lite"
  | "semantic-graph"
  | "structural";

/** Resolved engine after auto-detection or explicit choice. */
export type SearchResolvedMode =
  | "text"
  | "semantic-lite"
  | "semantic-graph"
  | "structural";

const STRUCTURAL_PHRASES: readonly string[] = [
  "what calls",
  "what imports",
  "what uses",
  "who calls",
  "callers of",
  "dependencies of",
  "dependents of",
  "dependency graph",
  "reverse dependencies",
  "who imports",
  "what depends on",
];

/** Auto mode: only text, semantic-lite (file scan), or structural — never semantic-graph / BM25 unless symbols index is warm. */
const SEMANTIC_LITE_PHRASES: readonly string[] = [
  "pattern",
  "logic",
  "handling",
  "approach",
  "similar to",
  "concept",
  "example",
  "how does",
  "where is the",
  "where is ",
  "error handling",
  "auth flow",
];

/**
 * When `mode` is `auto`, pick text vs semantic-lite vs structural.
 * Structural only on explicit multi-word phrases (avoids "related" → semantic, "imports" alone → structural).
 */
export function detectAutoSearchMode(query: string): Exclude<SearchResolvedMode, "semantic-graph"> {
  const q = query.toLowerCase();
  if (STRUCTURAL_PHRASES.some((p) => q.includes(p))) {
    return "structural";
  }
  if (SEMANTIC_LITE_PHRASES.some((p) => q.includes(p))) {
    return "semantic-lite";
  }
  return "text";
}

/** Map legacy `semantic` to blueprint-backed BM25 path. Unknown modes fall back to `auto`. */
export function normalizeRequestedSearchMode(mode: SearchModeInput | undefined): SearchModeInput {
  const m = String(mode ?? "auto").trim() as string;
  if (m === "semantic") return "semantic-graph";
  const allowed = new Set([
    "auto",
    "text",
    "semantic",
    "semantic-lite",
    "semantic-graph",
    "structural",
  ]);
  if (!allowed.has(m)) return "auto";
  return m as SearchModeInput;
}

/**
 * Final resolved mode (what we actually run).
 * - auto → detectAutoSearchMode; semantic-lite upgrades to semantic-graph when symbol index is warm
 * - explicit semantic-graph / structural / text / semantic-lite pass through
 */
export function resolveSearchMode(
  requested: SearchModeInput,
  query: string,
  opts?: { symbolIndexWarm?: boolean },
): SearchResolvedMode {
  const r = normalizeRequestedSearchMode(requested);
  if (r === "auto") {
    const detected = detectAutoSearchMode(query);
    if (detected === "semantic-lite" && opts?.symbolIndexWarm) {
      return "semantic-graph";
    }
    return detected;
  }
  if (r === "text") return "text";
  if (r === "structural") return "structural";
  if (r === "semantic-lite") return "semantic-lite";
  if (r === "semantic-graph") return "semantic-graph";
  return "text";
}

export function searchEngineLabel(resolved: SearchResolvedMode): string {
  switch (resolved) {
    case "text":
      return "ripgrep";
    case "semantic-lite":
      return "file_scan";
    case "semantic-graph":
      return "bm25_ctags";
    case "structural":
      return "ast_grep_graph";
    default:
      return "unknown";
  }
}
