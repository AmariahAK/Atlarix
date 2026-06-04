/**
 * File watcher: debounced incremental ctags + ast-grep blueprint cache refresh on code changes.
 */

import * as fs from "fs";
import * as path from "path";
import { updateBlueprintCacheForFiles } from "@/lib/blueprint/incremental-update";
import { invalidateBm25Index } from "@/lib/search/bm25_semantic_index";

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

  const pending = new Set<string>();

  watcher = fs.watch(projectPath, { recursive: true }, (_eventType, filename) => {
    if (!filename || typeof filename !== "string") return;
    const normalized = filename.replace(/\\/g, "/");
    if (!CODE_EXT.has(path.extname(normalized).toLowerCase())) return;
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
          invalidateBm25Index(lastWorkspaceId);
          const last = batch[batch.length - 1];
          if (last) await onUpdated?.(projectPath, last, lastWorkspaceId);
        }
      } catch {
        // ignore
      }
    }, DEBOUNCE_MS);
  });
}
