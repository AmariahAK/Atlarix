/**
 * File watcher: debounced incremental ctags/FTS5 search-index refresh on code
 * changes — keeps grep's Blueprint reranking fresh as the working tree evolves.
 */

import * as path from "path";
import { realpathSync } from "fs";
import log from "electron-log";
import { updateBm25IndexForFile } from "@/lib/search/bm25_semantic_index";
import {
  BUILTIN_IGNORE,
  composeIgnoreSource,
  createIgnorerFromSource,
  isRelPathIgnored,
  loadIgnorerForProject,
  type AtlarixIgnoreInstance,
} from "@/lib/atlarix/atlarix-ignore";

const logger = log.scope("search-index-watcher");

/** Minimal shape of the `@parcel/watcher` subscription we hold onto. */
type ParcelSubscription = { unsubscribe: () => Promise<void> };
type ParcelWatcher = {
  subscribe: (
    dir: string,
    cb: (err: Error | null, events: { type: string; path: string }[]) => void,
    opts: { ignore?: string[] },
  ) => Promise<ParcelSubscription>;
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

let subscription: ParcelSubscription | null = null;
/** Bumped on every (re)subscribe so a stale async subscribe result is discarded. */
let watchGeneration = 0;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let lastProjectPath: string | null = null;
let lastWorkspaceId: number | null = null;
const pending = new Set<string>();

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
  if (subscription && lastProjectPath === projectPath && lastWorkspaceId === workspaceId) {
    return;
  }
  void registerSearchIndexWatcher(projectPath, workspaceId);
}

/**
 * Stop the watcher and clear its state. Call on workspace close / app quit.
 */
export function stopSearchIndexWatcher(): void {
  watchGeneration++; // invalidate any in-flight subscribe
  if (subscription) {
    void subscription.unsubscribe().catch(() => {});
    subscription = null;
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
 * Lazily load `@parcel/watcher` (native). Returns null if it can't be loaded so
 * the app degrades gracefully to no incremental index rather than crashing — the
 * native binding may be missing/incompatible on some packaged builds.
 */
async function loadParcelWatcher(): Promise<ParcelWatcher | null> {
  try {
    const mod = (await import("@parcel/watcher")) as unknown as {
      default?: ParcelWatcher;
    } & ParcelWatcher;
    return (mod.default ?? mod) as ParcelWatcher;
  } catch (e) {
    logger.warn("@parcel/watcher unavailable — incremental search index disabled:", e);
    return null;
  }
}

/**
 * Convert a composed ignore SOURCE (BUILTIN ∪ .gitignore ∪ .atlarixignore, in
 * gitignore syntax) into `@parcel/watcher` ignore globs, so ignored directories
 * are pruned at REGISTRATION — never watched, so node_modules/.git/dist churn
 * produces zero events (the fix for the main-thread firehose). `.git` isn't in
 * gitignore syntax (git ignores it implicitly), so it's added explicitly.
 */
export function buildWatcherIgnore(composedSource: string): string[] {
  const globs = new Set<string>([
    "**/node_modules/**",
    "**/node_modules",
    "**/.git/**",
    "**/.git",
  ]);
  for (const rawLine of composedSource.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || line.startsWith("!")) continue;
    // Strip anchoring/trailing slashes; skip complex negations/character classes.
    const p = line.replace(/^\/+/, "").replace(/\/+$/, "");
    if (!p || p.includes("[")) continue;
    if (p.includes("/")) {
      globs.add(p);
      globs.add(`${p}/**`);
    } else {
      globs.add(`**/${p}`);
      globs.add(`**/${p}/**`);
    }
  }
  return [...globs];
}

/**
 * Register a `@parcel/watcher` subscription for projectPath. Ignored dirs are
 * excluded at the OS level; the surviving (tiny) event stream is filtered to
 * code files and debounced into incremental ctags/FTS5 refreshes.
 */
async function registerSearchIndexWatcher(
  projectPath: string | null,
  workspaceId: number | null,
): Promise<void> {
  // Tear down any prior subscription and take a fresh generation token.
  const generation = ++watchGeneration;
  if (subscription) {
    void subscription.unsubscribe().catch(() => {});
    subscription = null;
  }
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
  pending.clear();
  lastProjectPath = projectPath;
  lastWorkspaceId = workspaceId;
  if (!projectPath) return;

  // Reset to the sync baseline immediately, then upgrade to the composed ignorer.
  activeIgnorer = createIgnorerFromSource(BUILTIN_IGNORE);
  void refreshActiveIgnorer(projectPath);

  const parcel = await loadParcelWatcher();
  if (!parcel) return;

  let ignore: string[];
  try {
    ignore = buildWatcherIgnore(await composeIgnoreSource(projectPath));
  } catch {
    ignore = ["**/node_modules/**", "**/.git/**"];
  }

  // A newer register/stop superseded us while we awaited — abort this one.
  if (generation !== watchGeneration) return;

  // @parcel/watcher returns CANONICAL (realpath'd) event paths, so compute
  // relatives against the realpath'd root — otherwise a symlinked root (macOS
  // /var → /private/var) yields a `..`-escaping relative that the ignore matcher
  // rejects (RangeError), which would kill the callback.
  let realRoot = projectPath;
  try {
    realRoot = realpathSync(projectPath);
  } catch {
    /* keep projectPath */
  }

  const onEvents = (
    err: Error | null,
    events: { type: string; path: string }[],
  ): void => {
    if (err || generation !== watchGeneration) return;
    let sawCode = false;
    for (const ev of events) {
      const rel = path.relative(realRoot, ev.path).replace(/\\/g, "/");
      // Guard against any path outside the root (defensive; shouldn't happen).
      if (rel.startsWith("..")) continue;
      const base = rel.split("/").pop() ?? "";
      // Ignore-rule changes → recompose ignorer AND re-subscribe (the ignore set
      // itself changed). Debounced re-subscribe via generation guard.
      if (base === ".gitignore" || base === ".atlarixignore") {
        void registerSearchIndexWatcher(projectPath, workspaceId);
        return;
      }
      if (!shouldProcessWatcherPath(activeIgnorer, rel)) continue;
      pending.add(rel);
      sawCode = true;
    }
    if (!sawCode) return;
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(async () => {
      debounceTimer = null;
      const batch = [...pending];
      pending.clear();
      if (lastProjectPath !== projectPath || lastWorkspaceId == null) return;
      try {
        await Promise.all(
          batch.map((rel) => updateBm25IndexForFile(lastWorkspaceId!, projectPath, rel)),
        );
      } catch {
        /* ignore */
      }
    }, DEBOUNCE_MS);
  };

  try {
    const sub = await parcel.subscribe(projectPath, onEvents, { ignore });
    // Superseded while subscribing → immediately unsubscribe the stale one.
    if (generation !== watchGeneration) {
      void sub.unsubscribe().catch(() => {});
      return;
    }
    subscription = sub;
  } catch (e) {
    logger.warn("search index watcher subscribe failed:", e);
  }
}
