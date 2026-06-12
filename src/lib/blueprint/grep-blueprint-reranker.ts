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

    // Stable sort: Blueprint-relevant files first, original order within ties.
    const decorated = groups.map((g, i) => ({
      g,
      i,
      score: fileScore.get(norm(g.file)) ?? 0,
    }));
    decorated.sort((a, b) => (b.score - a.score) || (a.i - b.i));
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
