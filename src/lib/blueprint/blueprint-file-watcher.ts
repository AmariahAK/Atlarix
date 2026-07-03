/**
 * File watcher: debounced incremental ctags + ast-grep blueprint cache refresh on code changes.
 */

import * as fs from "fs";
import * as path from "path";
import { updateBlueprintCacheForFiles } from "@/lib/blueprint/incremental-update";
import { updateBm25IndexForFile } from "@/lib/search/bm25_semantic_index";
import {
  BUILTIN_IGNORE,
  createIgnorerFromSource,
  isRelPathIgnored,
  loadIgnorerForProject,
  type AtlarixIgnoreInstance,
} from "@/lib/atlarix/atlarix-ignore";

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
let refreshInFlight: Promise<boolean> | null = null;

/**
 * The active ignore filter applied at the watcher's event gate so churn in
 * node_modules/.git/dist never drives per-file ctags+ast-grep+FTS5 work (and
 * never escalates a cold cache to a full blueprint rebuild). Starts as the
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
 * Incrementally refresh RTE disk cache for changed files (ctags + ast-grep per file).
 */
export async function refreshBlueprintCacheFromFileTree(
  projectPath: string,
  changedFiles?: string[],
): Promise<boolean> {
  if (refreshInFlight) return refreshInFlight;

  refreshInFlight = (async () => {
    try {
      if (changedFiles?.length) {
        return updateBlueprintCacheForFiles(projectPath, changedFiles);
      }
      const { generateBlueprint, blueprintEngineLabel } = await import("@/lib/blueprint/rte/parsers");
      const { saveBlueprintCache } = await import("@/lib/cache/blueprint-cache");
      const result = await generateBlueprint(projectPath);
      if (!result) return false;
      await saveBlueprintCache(projectPath, {
        manifest: {
          projectPath,
          framework: result.framework.name,
          language: result.framework.name,
          engine: blueprintEngineLabel(result),
        },
        nodes: result.nodes,
        edges: result.edges,
        ...(result.atlarixIgnoreSource ? { atlarixIgnoreSource: result.atlarixIgnoreSource } : {}),
      });
      return true;
    } catch {
      return false;
    } finally {
      refreshInFlight = null;
    }
  })();

  return refreshInFlight;
}

/**
 * v14.8.10 Fix G: idempotent registration for the chat-stream preflight — keeps
 * the incremental FTS5/blueprint refresh alive in ordinary agent sessions (the
 * full `registerBlueprintFileWatcher` was only ever called when the Blueprint
 * panel was opened, so working-tree edits never refreshed the index). No-ops if
 * this project is already being watched, so it never downgrades a registration
 * that carries the panel's onUpdated callback.
 */
export function ensureBlueprintFileWatcher(
  projectPath: string | null,
  workspaceId: number | null,
): void {
  if (!projectPath) return;
  if (watcher && lastProjectPath === projectPath && lastWorkspaceId === workspaceId) {
    return;
  }
  registerBlueprintFileWatcher(projectPath, workspaceId);
}

/**
 * Register a file watcher for projectPath. On change, refreshes blueprint cache and calls onUpdated.
 */
export function registerBlueprintFileWatcher(
  projectPath: string | null,
  workspaceId: number | null,
  onUpdated?: (
    projectPath: string,
    relativePath: string,
    workspaceId: number,
  ) => void | Promise<void>,
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
    // node_modules churn no longer drives ctags/ast-grep/FTS5 per file.
    if (!shouldProcessWatcherPath(activeIgnorer, normalized)) return;
    pending.add(normalized);
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(async () => {
      debounceTimer = null;
      const batch = [...pending];
      pending.clear();
      if (lastProjectPath !== projectPath) return;
      try {
        const ok = await refreshBlueprintCacheFromFileTree(projectPath, batch);
        if (ok && lastWorkspaceId != null) {
          // Incremental per-file FTS5 update — no full rebuild (scales to big repos).
          await Promise.all(
            batch.map((rel) =>
              updateBm25IndexForFile(lastWorkspaceId!, projectPath, rel),
            ),
          );
          const last = batch[batch.length - 1];
          if (last) await onUpdated?.(projectPath, last, lastWorkspaceId);
        }
      } catch {
        // ignore
      }
    }, DEBOUNCE_MS);
  });
}
