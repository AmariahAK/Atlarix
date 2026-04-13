/**
 * Incremental parse cache: reuse previous Tree when the same file is re-parsed in-process.
 * Cleared per workspace when analysis or blueprint watcher scope resets.
 */

import type Parser from "tree-sitter";

const cache = new Map<string, Parser.Tree>();

export function getCachedTree(key: string): Parser.Tree | undefined {
  return cache.get(key);
}

export function setCachedTree(key: string, tree: Parser.Tree): void {
  cache.set(key, tree);
}

export function clearParseTreeCache(): void {
  cache.clear();
}

/** Delete entries whose cache key starts with workspacePath + NUL separator. */
export function clearParseTreeCacheForWorkspace(workspacePath: string): void {
  const norm = workspacePath.replace(/\\/g, "/");
  const prefix = `${norm}\0`;
  for (const k of [...cache.keys()]) {
    if (k.startsWith(prefix)) cache.delete(k);
  }
}

export function makeParseCacheKey(workspacePath: string, relativePath: string): string {
  return `${workspacePath.replace(/\\/g, "/")}\0${relativePath.replace(/\\/g, "/")}`;
}
