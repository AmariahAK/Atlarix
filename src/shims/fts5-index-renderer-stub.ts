/**
 * Renderer stub for `@/lib/search/fts5-index`.
 *
 * The real module opens a native `better-sqlite3` FTS5 database — main-process
 * only, and not bundleable into the browser/renderer target. Retrieval runs in
 * main (via the tool layer), so the renderer never calls these; stub them so a
 * stray transitive import can't drag `better-sqlite3` into the renderer bundle.
 */
import type { Bm25SearchResult } from "@/lib/search/retrieval-common";

export interface FtsSearchOpts {
  maxResults: number;
  restrictToFiles?: string[];
  package?: string;
}

export async function searchFts5(): Promise<Bm25SearchResult | null> {
  return null;
}
export function markFtsDirty(): void {}
export function invalidateFts(): void {}
export async function updateFtsForFile(): Promise<void> {}
