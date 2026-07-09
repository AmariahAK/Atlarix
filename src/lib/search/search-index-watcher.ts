/**
 * File watcher: debounced incremental ctags/FTS5 search-index refresh on code
 * changes — keeps grep's Blueprint reranking fresh as the working tree evolves.
 *
 * Uses chokidar (pure-JS, no native compile) with the project's composed ignorer
 * (BUILTIN ∪ .gitignore ∪ .atlarixignore) passed as `ignored` — so ignored
 * directories are PRUNED during traversal and never watched. node_modules/.git/
 * dist churn therefore produces zero events (the fix for the old recursive
 * `fs.watch` main-thread firehose, which also threw on Linux).
 */

import * as path from "path";
import { realpathSync } from "fs";
import log from "electron-log";
import { updateBm25IndexForFile } from "@/lib/search/bm25_semantic_index";
import {
  BUILTIN_IGNORE,
  createIgnorerFromSource,
  isRelPathIgnored,
  loadIgnorerForProject,
  type AtlarixIgnoreInstance,
} from "@/lib/atlarix/atlarix-ignore";

const logger = log.scope("search-index-watcher");

/** Minimal shape of the chokidar watcher we hold onto. */
type ChokidarWatcher = {
  on: (event: string, cb: (...args: unknown[]) => void) => ChokidarWatcher;
  close: () => Promise<void>;
};
type ChokidarModule = {
  watch: (paths: string, opts: Record<string, unknown>) => ChokidarWatcher;
};

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

let watcher: ChokidarWatcher | null = null;
/** Bumped on every (re)watch/stop so a stale async watch result is discarded. */
let watchGeneration = 0;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let lastProjectPath: string | null = null;
let lastWorkspaceId: number | null = null;
const pending = new Set<string>();

/**
 * The active ignore filter (BUILTIN baseline → upgraded to the composed
 * ignorer once .gitignore/.atlarixignore load). Used BOTH to prune chokidar's
 * traversal (`ignored`) and as the per-event code-file gate.
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
  void registerSearchIndexWatcher(projectPath, workspaceId);
}

/** Stop the watcher and clear its state. Call on workspace close / app quit. */
export function stopSearchIndexWatcher(): void {
  watchGeneration++; // invalidate any in-flight watch
  if (watcher) {
    void watcher.close().catch(() => {});
    watcher = null;
  }
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
  pending.clear();
  lastProjectPath = null;
  lastWorkspaceId = null;
}

/**
 * Lazily load chokidar. Returns null (→ no incremental index, graceful) if it
 * can't be loaded, rather than crashing.
 */
async function loadChokidar(): Promise<ChokidarModule | null> {
  try {
    const mod = (await import("chokidar")) as unknown as {
      default?: ChokidarModule;
    } & ChokidarModule;
    return (mod.default ?? mod) as ChokidarModule;
  } catch (e) {
    logger.warn("chokidar unavailable — incremental search index disabled:", e);
    return null;
  }
}

/**
 * Watch projectPath with chokidar. Ignored dirs are pruned at traversal via the
 * composed ignorer; the surviving (tiny) event stream is filtered to code files
 * and debounced into incremental ctags/FTS5 refreshes.
 */
async function registerSearchIndexWatcher(
  projectPath: string | null,
  workspaceId: number | null,
): Promise<void> {
  const generation = ++watchGeneration;
  if (watcher) {
    void watcher.close().catch(() => {});
    watcher = null;
  }
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
  pending.clear();
  lastProjectPath = projectPath;
  lastWorkspaceId = workspaceId;
  if (!projectPath) return;

  // Reset to the sync baseline immediately (so node_modules/.git are pruned even
  // during the async load window), then upgrade to the composed ignorer.
  activeIgnorer = createIgnorerFromSource(BUILTIN_IGNORE);
  void refreshActiveIgnorer(projectPath);

  const chokidar = await loadChokidar();
  if (!chokidar || generation !== watchGeneration) return;

  let realRoot = projectPath;
  try {
    realRoot = realpathSync(projectPath);
  } catch {
    /* keep projectPath */
  }

  const toRel = (abs: string): string =>
    path.relative(realRoot, abs).replace(/\\/g, "/");

  // Prune ignored dirs at traversal. `.git` isn't gitignore syntax (git ignores
  // it implicitly), so it's forced here alongside node_modules.
  const ignored = (abs: string): boolean => {
    if (abs === realRoot) return false;
    const rel = toRel(abs);
    if (!rel || rel.startsWith("..")) return false;
    if (/(^|\/)(node_modules|\.git)(\/|$)/.test(rel)) return true;
    return isRelPathIgnored(activeIgnorer, rel);
  };

  const onFsEvent = (event: string, abs: string): void => {
    if (generation !== watchGeneration) return;
    if (event === "addDir" || event === "unlinkDir") return;
    if (typeof abs !== "string") return;
    const rel = toRel(abs);
    if (rel.startsWith("..")) return;
    const base = rel.split("/").pop() ?? "";
    // Ignore-rule change → recompose ignorer AND re-watch (the prune set changed).
    if (base === ".gitignore" || base === ".atlarixignore") {
      void registerSearchIndexWatcher(projectPath, workspaceId);
      return;
    }
    if (!shouldProcessWatcherPath(activeIgnorer, rel)) return;
    pending.add(rel);
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(async () => {
      debounceTimer = null;
      const batch = [...pending];
      pending.clear();
      if (lastProjectPath !== projectPath || lastWorkspaceId == null) return;
      try {
        await Promise.all(
          batch.map((r) => updateBm25IndexForFile(lastWorkspaceId!, projectPath, r)),
        );
      } catch {
        /* ignore */
      }
    }, DEBOUNCE_MS);
  };

  try {
    const w = chokidar.watch(realRoot, {
      ignored,
      ignoreInitial: true,
      persistent: true,
      followSymlinks: false,
      ignorePermissionErrors: true,
    });
    w.on("error", () => {});
    w.on("all", (...args: unknown[]) =>
      onFsEvent(args[0] as string, args[1] as string),
    );
    if (generation !== watchGeneration) {
      void w.close().catch(() => {});
      return;
    }
    watcher = w;
  } catch (e) {
    logger.warn("search index watcher failed:", e);
  }
}
