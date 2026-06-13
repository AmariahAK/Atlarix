/**
 * Blueprint-backed grep ranking.
 *
 * Blueprint is Atlarix's permanent retrieval substrate — the structural+lexical
 * answer to a vector index (no embeddings, by design). This makes Blueprint back
 * grep: raw ripgrep returns matches in file order; here we reorder those file
 * groups by Blueprint's own BM25 relevance for the query, so the most relevant
 * files surface first (and survive the result cap). The BM25 index is the same
 * one `get_blueprint` uses — warm, persistent, and incrementally refreshed by the
 * blueprint file watcher — so this is cheap on the hot path.
 *
 * Stable interface: a future improved Blueprint (better ranking, call-graph
 * weighting, structural signals) upgrades grep, sub-agents, and ambient context
 * behind `searchBlueprintBm25` without changing any caller.
 */

import log from "electron-log";
import path from "node:path";
import { searchBlueprintBm25 } from "@/lib/search/bm25_semantic_index";

const logger = log.scope("grep-blueprint");

export type RankableGrepGroup = { file: string; matches: { line: number; content: string }[] };

/** Don't let a cold index build stall an interactive grep. */
const RANK_TIMEOUT_MS = 1_500;

/** Reciprocal Rank Fusion constant (standard default). Larger = flatter fusion. */
const RRF_K = 60;
/** BM25 (topical relevance) leads the fusion; ripgrep order is a weaker
 * match-position signal that breaks near-ties rather than overriding BM25. */
const BM25_RRF_WEIGHT = 2;

function norm(p: string): string {
  return path.resolve(p);
}

/**
 * Reorder grep file-groups by Blueprint (BM25) relevance to `query`. Returns the
 * groups unchanged (original order) when Blueprint has nothing to say, the index
 * isn't ready, or anything errors — grep must never be worse than plain ripgrep.
 */
export async function rankGrepHitsByBlueprint(
  groups: RankableGrepGroup[],
  opts: { workspaceId?: number; workspaceRootAbs?: string; query: string },
): Promise<RankableGrepGroup[]> {
  if (groups.length <= 1) return groups;
  if (opts.workspaceId == null || !opts.workspaceRootAbs) return groups;
  const query = opts.query.trim();
  if (!query) return groups;

  try {
    // Contain the search promise's own rejection so the race never surfaces it
    // (a cold/failed index must degrade to plain ripgrep, not throw).
    const searchPromise = searchBlueprintBm25(
      opts.workspaceId,
      opts.workspaceRootAbs,
      query,
      500,
    ).catch((e) => {
      logger.debug("Blueprint grep ranking search failed:", e);
      return null;
    });
    const search = await Promise.race([
      searchPromise,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), RANK_TIMEOUT_MS)),
    ]);
    if (!search || search.hits.length === 0) return groups;

    // file → best BM25 score (hits carry absolute paths, as does ripgrep here).
    const fileScore = new Map<string, number>();
    for (const hit of search.hits) {
      const key = norm(hit.file);
      const prev = fileScore.get(key) ?? 0;
      if (hit.score > prev) fileScore.set(key, hit.score);
    }
    if (fileScore.size === 0) return groups;

    // Reciprocal Rank Fusion of two signals: Blueprint BM25 relevance (weighted
    // higher — it's the authoritative topical signal) and ripgrep's own file
    // order (a weaker match-position proxy that breaks near-ties). RRF is
    // scale-free, so the fusion is robust to BM25 score outliers while ripgrep
    // order still influences close calls. Files with no BM25 score rank by
    // ripgrep order among themselves.
    const bm25Ranked = [...fileScore.entries()].sort((a, b) => b[1] - a[1]);
    const bm25Rank = new Map<string, number>();
    bm25Ranked.forEach(([file], idx) => bm25Rank.set(file, idx + 1));
    const worstBm25Rank = bm25Ranked.length + 1;

    const decorated = groups.map((g, i) => {
      const key = norm(g.file);
      const rRipgrep = i + 1;
      const rBm25 = bm25Rank.get(key) ?? worstBm25Rank;
      const rrf =
        BM25_RRF_WEIGHT / (RRF_K + rBm25) + 1 / (RRF_K + rRipgrep);
      return { g, i, rrf };
    });
    decorated.sort((a, b) => b.rrf - a.rrf || a.i - b.i);
    const ranked = decorated.map((d) => d.g);

    const moved = ranked.some((g, idx) => g !== groups[idx]);
    if (moved) {
      logger.debug(
        `Blueprint-ranked ${groups.length} grep file group(s) for "${query.slice(0, 40)}"`,
      );
    }
    return ranked;
  } catch (e) {
    logger.debug("Blueprint grep ranking skipped:", e);
    return groups;
  }
}

/**
 * v13.2: zero-hit grep fallback. When ripgrep finds nothing, ask Blueprint's
 * BM25 for the closest indexed symbols so the model gets a lead instead of a
 * dead end (saves the wasted retry round). Returns a short formatted block
 * (≤ `maxSuggestions` lines, one file each) or null when Blueprint has
 * nothing / isn't ready — same degrade-silently discipline as ranking.
 */
export async function suggestClosestIndexedSymbols(opts: {
  workspaceId?: number;
  workspaceRootAbs?: string;
  query: string;
  maxSuggestions?: number;
}): Promise<string | null> {
  if (opts.workspaceId == null || !opts.workspaceRootAbs) return null;
  const query = opts.query.trim();
  if (!query) return null;
  const max = Math.min(10, Math.max(1, opts.maxSuggestions ?? 5));

  try {
    const searchPromise = searchBlueprintBm25(
      opts.workspaceId,
      opts.workspaceRootAbs,
      query,
      50,
    ).catch((e) => {
      logger.debug("Blueprint zero-hit suggestion search failed:", e);
      return null;
    });
    const search = await Promise.race([
      searchPromise,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), RANK_TIMEOUT_MS)),
    ]);
    if (!search || search.hits.length === 0) return null;

    const root = norm(opts.workspaceRootAbs);
    const seenFiles = new Set<string>();
    const lines: string[] = [];
    for (const hit of search.hits) {
      if (lines.length >= max) break;
      const abs = norm(hit.file);
      if (seenFiles.has(abs)) continue;
      seenFiles.add(abs);
      const rel = abs.startsWith(root)
        ? path.relative(root, abs)
        : hit.file;
      const preview = (hit.content ?? "").trim().slice(0, 120);
      lines.push(`  ${rel}:${hit.line}${preview ? `  ${preview}` : ""}`);
    }
    if (lines.length === 0) return null;
    return `Closest indexed symbols (Blueprint lexical match — not regex hits):\n${lines.join("\n")}`;
  } catch (e) {
    logger.debug("Blueprint zero-hit suggestion skipped:", e);
    return null;
  }
}
