/**
 * v12 Tier 6 #5 — per-(workspace, focus, topic, scope, path, depth) cache of
 * built get_blueprint slices. Re-exploring the same section is common; the
 * parse is already cached, but the BM25 fusion + slice ranking re-run every
 * call. This memoizes the final SliceResult.
 *
 * Invalidation reuses the existing per-workspace reparse signal:
 * `markBlueprintSliceDirty(workspaceId)` is called right beside
 * `markBm25Dirty(workspaceId)` in setCachedBlueprint, so any blueprint reparse
 * drops that workspace's cached slices.
 */

import type { SliceResult } from "./blueprint-slice";

interface CacheEntry {
  workspaceId: number;
  slice: SliceResult;
  sliceWidened: boolean;
}

const SLICE_CACHE_MAX = 32;
const cache = new Map<string, CacheEntry>(); // insertion-ordered LRU
const dirtyWorkspaces = new Set<number>();

export function sliceCacheKey(input: {
  workspaceId: number;
  focusPath: string;
  topic?: string;
  scope: string;
  path?: string;
  depth: number;
}): string {
  return [
    input.workspaceId,
    input.focusPath,
    input.topic ?? "",
    input.scope,
    input.path ?? "",
    input.depth,
  ].join("|");
}

export function getCachedSlice(
  key: string,
  workspaceId: number,
): { slice: SliceResult; sliceWidened: boolean } | null {
  if (dirtyWorkspaces.has(workspaceId)) {
    // Drop all entries for this workspace, then clear the flag.
    for (const [k, v] of cache) {
      if (v.workspaceId === workspaceId) cache.delete(k);
    }
    dirtyWorkspaces.delete(workspaceId);
    return null;
  }
  const hit = cache.get(key);
  if (!hit) return null;
  // LRU touch.
  cache.delete(key);
  cache.set(key, hit);
  return { slice: hit.slice, sliceWidened: hit.sliceWidened };
}

export function setCachedSlice(
  key: string,
  workspaceId: number,
  slice: SliceResult,
  sliceWidened: boolean,
): void {
  cache.set(key, { workspaceId, slice, sliceWidened });
  while (cache.size > SLICE_CACHE_MAX) {
    const oldest = cache.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

/** Called from setCachedBlueprint on every reparse (beside markBm25Dirty). */
export function markBlueprintSliceDirty(workspaceId: number): void {
  dirtyWorkspaces.add(workspaceId);
}

/** Test seam. */
export function _resetSliceCache(): void {
  cache.clear();
  dirtyWorkspaces.clear();
}
