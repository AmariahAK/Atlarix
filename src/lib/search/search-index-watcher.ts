/**
 * File watcher: debounced incremental ctags/FTS5 search-index refresh on code
 * changes — keeps grep's Blueprint reranking fresh as the working tree evolves.
 */

import * as fs from "fs";
import * as path from "path";
import { updateBm25IndexForFile } from "@/lib/search/bm25_semantic_index";
import {
  BUILTIN_IGNORE,
  createIgnorerFromSource,
  isRelPathIgnored,
  loadIgnorerForProject,
  type AtlarixIgnoreInstance,
} from "@/lib/atlarix/atlarix-ignore";

/**
 * Churn gate, not a support gate: files outside this set are still indexed by
 * full rebuilds (ctags auto-detects every language it knows) — this only bounds
 * which watcher EVENTS trigger per-file re-index work.
 */
const CODE_EXT = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".py",
  ".java",
  ".kt",
  ".kts",
  ".go",
  ".rs",
  ".cs",
  ".rb",
  ".php",
  ".swift",
  ".ex",
  ".exs",
]);
const DEBOUNCE_MS = 500;

let watcher: fs.FSWatcher | null = null;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let lastProjectPath: string | null = null;
let lastWorkspaceId: number | null = null;

/**
 * The active ignore filter applied at the watcher's event gate so churn in
 * node_modules/.git/dist never drives per-file ctags+FTS5 work. Starts as the
 * synchronous BUILTIN_IGNORE baseline and is upgraded to the project's full
 * composed ignorer (baseline ∪ .gitignore ∪ .atlarixignore) once it loads.
 */
let activeIgnorer: AtlarixIgnoreInstance = createIgnorerFromSource(BUILTIN_IGNORE);

/**
 * A watcher event is worth indexing only if it's a code file that isn't ignored.
 * Pure + exported for tests.
 */
export function shouldProcessWatcherPath(
  ig: AtlarixIgnoreInstance,
  relPath: string,
): boolean {
  if (!CODE_EXT.has(path.extname(relPath).toLowerCase())) return false;
  return !isRelPathIgnored(ig, relPath);
}

/** Load the project's composed ignorer, keeping the baseline fallback on error. */
async function refreshActiveIgnorer(projectPath: string): Promise<void> {
  try {
    const ig = await loadIgnorerForProject(projectPath);
    // Only apply if this is still the watched project (guards workspace switches).
    if (lastProjectPath === projectPath) activeIgnorer = ig;
  } catch {
    /* keep the BUILTIN_IGNORE baseline */
  }
}

/**
 * Idempotent registration for the chat-stream preflight — keeps the incremental
 * FTS5 refresh alive in ordinary agent sessions. No-ops if this project is
 * already being watched.
 */
export function ensureSearchIndexWatcher(
  projectPath: string | null,
  workspaceId: number | null,
): void {
  if (!projectPath) return;
  if (watcher && lastProjectPath === projectPath && lastWorkspaceId === workspaceId) {
    return;
  }
  registerSearchIndexWatcher(projectPath, workspaceId);
}

/**
 * Register a file watcher for projectPath. On change, incrementally refreshes
 * the per-file ctags symbols + FTS5 rows (no full rebuild — scales to big repos).
 */
function registerSearchIndexWatcher(
  projectPath: string | null,
  workspaceId: number | null,
): void {
  if (watcher) {
    watcher.close();
    watcher = null;
  }
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
  lastProjectPath = projectPath;
  lastWorkspaceId = workspaceId;

  if (!projectPath) return;

  // Reset to the sync baseline immediately (so node_modules/.git churn is
  // filtered even during the async load window), then upgrade to the project's
  // full composed ignorer.
  activeIgnorer = createIgnorerFromSource(BUILTIN_IGNORE);
  void refreshActiveIgnorer(projectPath);

  const pending = new Set<string>();

  watcher = fs.watch(projectPath, { recursive: true }, (_eventType, filename) => {
    if (!filename || typeof filename !== "string") return;
    const normalized = filename.replace(/\\/g, "/");
    // A change to ignore rules invalidates the cached ignorer (these files are
    // not CODE_EXT, so handle them before the gate).
    const base = normalized.split("/").pop() ?? "";
    if (base === ".gitignore" || base === ".atlarixignore") {
      void refreshActiveIgnorer(projectPath);
      return;
    }
    // Skip non-code files AND anything ignored (deps/build/caches) — the big win:
    // node_modules churn no longer drives ctags/FTS5 work per file.
    if (!shouldProcessWatcherPath(activeIgnorer, normalized)) return;
    pending.add(normalized);
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(async () => {
      debounceTimer = null;
      const batch = [...pending];
      pending.clear();
      if (lastProjectPath !== projectPath) return;
      if (lastWorkspaceId == null) return;
      try {
        await Promise.all(
          batch.map((rel) =>
            updateBm25IndexForFile(lastWorkspaceId!, projectPath, rel),
          ),
        );
      } catch {
        // ignore
      }
    }, DEBOUNCE_MS);
  });
}
