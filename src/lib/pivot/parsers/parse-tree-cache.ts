/**
 * PASS6: tree-sitter unavailable; cache helpers reduce to no-ops.
 */

import type { TreeStub as Tree } from "./tree-sitter-parser";

export function getCachedTree(_key: string): Tree | undefined {
  return undefined;
}

export function setCachedTree(_key: string, _tree: Tree): void {
  // no-op
}

export function clearParseTreeCache(): void {
  // no-op
}

export function clearParseTreeCacheForWorkspace(_workspacePath: string): void {
  // no-op
}

export function makeParseCacheKey(workspacePath: string, relativePath: string): string {
  return `${workspacePath}:${relativePath}`;
}
