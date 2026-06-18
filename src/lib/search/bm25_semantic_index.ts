/**
 * Code-retrieval index — public facade.
 *
 * v14: the lexical engine moved from an in-memory wink-bm25 index (rebuilt over
 * EVERY symbol on each search — the source of OOM on giant repos) to a
 * disk-backed SQLite FTS5 index (`fts5-index.ts`): ~constant low memory at any
 * size, incremental updates, scales to monorepos / multi-repo. This module keeps
 * the SAME public API so the grep reranker, get_blueprint room scoring, and the
 * Tier-1 RRF/proximity logic are unchanged.
 */

import {
  type Bm25BeaconHit,
  type Bm25SearchResult,
  tokenizeForBm25,
  isGenericIdentifierName,
} from "./retrieval-common";
import {
  searchFts5,
  markFtsDirty,
  invalidateFts,
  updateFtsForFile,
  type FtsSearchOpts,
} from "./fts5-index";

// Re-exports preserve the existing import sites.
export type { Bm25BeaconHit, Bm25SearchResult };
export { tokenizeForBm25, isGenericIdentifierName };

/** Mark the index stale; rebuilt lazily on the next search. */
export function markBm25Dirty(workspaceId: number): void {
  markFtsDirty(workspaceId);
}

/** Drop the index (closes the DB handle) and mark dirty. */
export function invalidateBm25Index(workspaceId: number): void {
  invalidateFts(workspaceId);
}

/** Incremental per-file refresh (file-watcher path) — no full rebuild. */
export function updateBm25IndexForFile(
  workspaceId: number,
  workspaceRootAbs: string,
  relFile: string,
): Promise<void> {
  return updateFtsForFile(workspaceId, workspaceRootAbs, relFile);
}

/**
 * Lexical search over the workspace's symbol index (FTS5/bm25). `opts` allows
 * candidate-set reranking (`restrictToFiles`) and per-package scoping (`package`).
 */
export async function searchBlueprintBm25(
  workspaceId: number,
  workspaceRootAbs: string,
  query: string,
  maxResults: number,
  opts?: Pick<FtsSearchOpts, "restrictToFiles" | "package">,
): Promise<Bm25SearchResult | null> {
  return searchFts5(workspaceId, workspaceRootAbs, query, {
    maxResults,
    restrictToFiles: opts?.restrictToFiles,
    package: opts?.package,
  });
}

