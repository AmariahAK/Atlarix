import fs from "node:fs";
import * as path from "node:path";

export type WorkspaceDiscoveryHints = {
  hasRootGit: boolean;
  /** True when root has no `.git` but one or more immediate children do. */
  isMultiRepoWorkspace: boolean;
  /** Sorted child directory names (each contains `.git`). */
  nestedRepoNames?: string[];
};

const discoverySessionCache = new Map<string, WorkspaceDiscoveryHints>();

/** Clear cached layout hints (e.g. after workspace path changes). */
export function clearWorkspaceDiscoverySessionCache(workspacePath?: string): void {
  if (workspacePath) {
    discoverySessionCache.delete(path.resolve(workspacePath));
  } else {
    discoverySessionCache.clear();
  }
}

function computeWorkspaceDiscovery(resolved: string): WorkspaceDiscoveryHints {
  let hasRootGit = false;
  try {
    hasRootGit = fs.existsSync(path.join(resolved, ".git"));
  } catch {
    return { hasRootGit: false, isMultiRepoWorkspace: false };
  }
  if (hasRootGit) {
    return { hasRootGit: true, isMultiRepoWorkspace: false };
  }

  const nested: string[] = [];
  try {
    const entries = fs.readdirSync(resolved, { withFileTypes: true });
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (e.name === ".git") continue;
      try {
        if (fs.existsSync(path.join(resolved, e.name, ".git"))) {
          nested.push(e.name);
        }
      } catch {
        /* skip unreadable child */
      }
    }
  } catch {
    return { hasRootGit: false, isMultiRepoWorkspace: false };
  }

  nested.sort((a, b) => a.localeCompare(b));
  const isMultiRepo = nested.length > 0;
  return {
    hasRootGit: false,
    isMultiRepoWorkspace: isMultiRepo,
    ...(isMultiRepo ? { nestedRepoNames: nested } : {}),
  };
}

/**
 * Layout hints for file discovery and UI — **one disk scan per resolved root per process**
 * unless {@link clearWorkspaceDiscoverySessionCache} is called.
 */
export function getCachedWorkspaceDiscovery(workspacePath: string): WorkspaceDiscoveryHints {
  const resolved = path.resolve(workspacePath);
  let hit = discoverySessionCache.get(resolved);
  if (!hit) {
    hit = computeWorkspaceDiscovery(resolved);
    discoverySessionCache.set(resolved, hit);
  }
  return hit;
}

/**
 * @deprecated Prefer {@link getCachedWorkspaceDiscovery} for file discovery; kept for call sites that need fresh reads in tests.
 */
export function analyzeWorkspaceDiscovery(workspacePath: string): WorkspaceDiscoveryHints {
  return getCachedWorkspaceDiscovery(workspacePath);
}

/** Cache key invalidates when multi-repo membership changes. */
export function projectFilesCacheKey(workspacePath: string): string {
  const resolved = path.resolve(workspacePath);
  const d = getCachedWorkspaceDiscovery(resolved);
  if (d.isMultiRepoWorkspace && d.nestedRepoNames?.length) {
    return `${resolved}\0multi:${d.nestedRepoNames.join("\x1f")}`;
  }
  return `${resolved}\0single`;
}
