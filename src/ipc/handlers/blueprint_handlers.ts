/**
 * Blueprint IPC Handlers (Phase 7 Additive Blueprint)
 * ===================================================
 * Blueprints are not persisted (only Live diagrams are saved). In-memory cache per workspace
 * so AI tools and UI share current state; blueprint:updated notifies the renderer.
 */

import { ipcMain, BrowserWindow } from "electron";
import * as path from "path";
import { db } from "@/db";
import { apps, diagrams } from "@/db/schema";
import { eq } from "drizzle-orm";
import type { Blueprint, BlueprintRoom, CombinedBlueprint } from "@/shared/blueprint-types";
import { createEmptyBlueprint } from "@/shared/blueprint-types";
import { getAtlarixAppPath } from "@/paths/paths";
import { registerBlueprintFileWatcher } from "@/lib/blueprint/blueprint-file-watcher";
import {
  buildRichDiagramMarkdown,
  captureSnapshot,
  ensureInitialDiagramSnapshot,
  extractMermaidFromMarkdown,
} from "@/lib/snapshot/snapshot-manager";
import { analyzeWorkspaceWithActivity, type ProjectCandidate } from "@/lib/blueprint/project-selector";
import { generateCombinedBlueprint } from "@/lib/blueprint/combined-generator";
import { loadBlueprintCache, saveBlueprintCache, saveUserBlueprint, loadUserBlueprint, getUserBlueprintMtime } from "@/lib/cache/blueprint-cache";
import {
  ATLARIX_IGNORE_FILENAME,
  createIgnorerFromSource,
  ensureDefaultAtlarixIgnore,
  filterRteEdgesByNodes,
  filterRteNodesByIgnore,
  getAtlarixIgnorePath,
  loadIgnorerForProject,
  readAtlarixIgnoreSource,
} from "@/lib/atlarix/atlarix-ignore";
import { scheduleBlueprintChangeSnapshot } from "@/lib/project-memory/service";
import { generateFromBlueprintDelta, type CodegenDelta, type CodegenResult } from "@/lib/blueprint/codegen";
import { inferBlueprintFromWorkspace } from "@/lib/blueprint/workspace_to_blueprint";
import { rteResultToBlueprint } from "@/lib/blueprint/rte_to_blueprint";
import { generateBlueprint, blueprintEngineLabel } from "@/lib/blueprint/rte/parsers";
import { invalidateSymbolIndex } from "@/lib/index/ctags-index";
import { buildBlueprintFromFileTree } from "@/lib/blueprint/fileTreeSource";
import {
  mergeBlueprintWithFileTree,
  normalizedRoomKey,
} from "@/lib/blueprint/blueprint-merge";
import { countVisibleRooms } from "@/lib/blueprint/blueprint-slice";
import { validateBlueprintFocusPath } from "@/lib/blueprint/section-path";
import { getReferencePaths, setReferencePaths, buildCombinedBlueprint, saveCombinedBlueprint } from "@/lib/blueprint/reference-manager";
import { enrichAll } from "@/lib/blueprint/enricher";
import { ensurePlansDir } from "@/lib/plans/plan-manager";
import * as fs from "node:fs/promises";
import { getCachedAnalysis } from "@/lib/analysis/workspace-cache";
import { analyzeWorkspace } from "@/lib/analysis/workspace-analyzer";
import { simplifyDescriptionWithAI, simplifyRoomWithAI, simplifyArchitectureWithAI } from "@/lib/blueprint/descriptions/aiSimplifier";
import log from "electron-log";
import { invalidateBm25Index, markBm25Dirty } from "@/lib/search/bm25_semantic_index";
import { app as electronApp } from "electron";
import { SubscriptionManager } from "@/lib/SubscriptionManager";
import { getCurrentCommitHash } from "@/ipc/utils/git_utils";
import {
  blueprintSnapshotExists,
  getBlueprintSnapshotMtime,
  loadBlueprintSnapshot,
  logSnapshotLoaded,
  snapshotBlueprintToRepo,
  snapshotToBlueprint,
} from "@/lib/blueprint/blueprint-snapshot";
import {
  blueprintCacheKey,
  normalizeBlueprintFocusPath,
  resolveScanRoot,
} from "@/lib/blueprint/parse-scope";

const logger = log.scope("blueprint_handlers");

export type GetBlueprintOptions = {
  focusPath?: string;
  allowWorkspaceRoot?: boolean;
};

/** Cap in-memory blueprint sections (workspace + focus_path). */
const MAX_BLUEPRINT_CACHE_ENTRIES = 28;

type BlueprintCacheEntry = {
  blueprint: Blueprint;
  workspaceId: number;
  focusPath: string;
  inferredEdgesMerged: boolean;
  engine?: "ast-grep+ctags" | "file-tree" | "hybrid";
};

const blueprintCache = new Map<string, BlueprintCacheEntry>();

function touchBlueprintCache(cacheKey: string): void {
  const entry = blueprintCache.get(cacheKey);
  if (entry === undefined) return;
  blueprintCache.delete(cacheKey);
  blueprintCache.set(cacheKey, entry);
}

function setCachedBlueprint(
  workspaceId: number,
  focusPath: string,
  b: Blueprint,
  options?: { inferredEdgesMerged?: boolean; engine?: "ast-grep+ctags" | "file-tree" | "hybrid" },
): void {
  const key = blueprintCacheKey(workspaceId, focusPath);
  const prev = blueprintCache.get(key);
  blueprintCache.delete(key);
  blueprintCache.set(key, {
    blueprint: b,
    workspaceId,
    focusPath: normalizeBlueprintFocusPath(focusPath) || ".",
    inferredEdgesMerged:
      options?.inferredEdgesMerged ?? prev?.inferredEdgesMerged ?? false,
    engine: options?.engine ?? prev?.engine,
  });
  markBm25Dirty(workspaceId);
  while (blueprintCache.size > MAX_BLUEPRINT_CACHE_ENTRIES) {
    const oldest = blueprintCache.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    const evicted = blueprintCache.get(oldest);
    blueprintCache.delete(oldest);
    if (evicted) invalidateBm25Index(evicted.workspaceId);
  }
}

function getCachedBlueprint(
  workspaceId: number,
  focusPath: string,
): BlueprintCacheEntry | undefined {
  return blueprintCache.get(blueprintCacheKey(workspaceId, focusPath));
}

/** Parse engine label for a section (AI tool metadata). */
export function getBlueprintSectionMeta(
  workspaceId: number,
  focusPath: string,
): { engine?: "ast-grep+ctags" | "file-tree" | "hybrid" } {
  const fp = normalizeBlueprintFocusPath(focusPath) || ".";
  const mem = getCachedBlueprint(workspaceId, fp);
  return { engine: mem?.engine };
}

/** Legacy: first cached section for workspace (IPC paths without focus). */
function getAnyCachedBlueprintForWorkspace(
  workspaceId: number,
): BlueprintCacheEntry | undefined {
  const prefix = `${workspaceId}:`;
  for (const [key, entry] of blueprintCache) {
    if (key.startsWith(prefix)) return entry;
  }
  return undefined;
}

const INVALID_ROOM_NAMES = new Set([".", "..", ""]);

function sanitizeBlueprint(b: Blueprint): Blueprint {
  const rooms = (b.rooms ?? [])
    .filter((r) => r.label != null && !INVALID_ROOM_NAMES.has(String(r.label).trim()))
    .map((r) => ({
      ...r,
      functions: r.functions ?? [],
    }));
  const roomIds = new Set(rooms.map((r) => r.id));
  const edges = (b.edges ?? []).filter((e) => roomIds.has(e.from) && roomIds.has(e.to));
  const out: Blueprint = { rooms, edges, envRefs: b.envRefs ?? [] };
  if (b.removedInferredEdgeKeys?.length) out.removedInferredEdgeKeys = b.removedInferredEdgeKeys;
  return out;
}

function sendToAllWindows(channel: string, payload: unknown) {
  const wins = BrowserWindow.getAllWindows();
  wins.forEach((win) => {
    if (!win.isDestroyed() && win.webContents) {
      win.webContents.send(channel, payload);
    }
  });
}

/**
 * Notify renderer that AI is editing the blueprint (for visual indicator)
 */
export function emitBlueprintAiEditing(workspaceId: number, action: string) {
  sendToAllWindows("blueprint:ai-editing", { workspaceId, action });
}

function cacheBlueprintIfNonEmpty(
  workspaceId: number,
  focusPath: string,
  blueprint: Blueprint,
  options?: { inferredEdgesMerged?: boolean; engine?: "ast-grep+ctags" | "file-tree" | "hybrid" },
): void {
  if (countVisibleRooms(blueprint) > 0) {
    setCachedBlueprint(workspaceId, focusPath, blueprint, options);
  }
}

/** Infer blueprint for one section: RTE disk cache → generateBlueprint(scanRoot) → file-tree. */
async function inferBlueprint(workspaceId: number, focusPath: string): Promise<Blueprint> {
  const [app] = await db.select().from(apps).where(eq(apps.id, workspaceId)).limit(1);
  if (!app) return createEmptyBlueprint();
  const workspacePath = getAtlarixAppPath(app.path);
  const fp = normalizeBlueprintFocusPath(focusPath) || ".";
  const scanRoot = resolveScanRoot(workspacePath, fp);

  if (fp !== ".") {
    const pathCheck = await validateBlueprintFocusPath(workspacePath, fp);
    if (!pathCheck.valid) {
      logger.warn("inferBlueprint: scan root does not exist", {
        workspaceId,
        focusPath: fp,
        scanRoot,
        suggestions: pathCheck.suggestions,
      });
      return createEmptyBlueprint();
    }
  }

  const cached = await loadBlueprintCache(scanRoot);
  if (cached && cached.nodes.length > 0) {
    const ig = cached.atlarixIgnoreSource?.trim()
      ? createIgnorerFromSource(cached.atlarixIgnoreSource)
      : await loadIgnorerForProject(scanRoot);
    const nodes = filterRteNodesByIgnore(cached.nodes, ig, scanRoot);
    const kept = new Set(nodes.map((n) => n.id));
    const edges = filterRteEdgesByNodes(cached.edges, kept);
    const b = rteResultToBlueprint(
      {
        nodes,
        edges,
        framework: { name: cached.manifest.framework, confidence: 0.8 },
      },
      scanRoot,
    );
    if (b.rooms.length > 0) {
      cacheBlueprintIfNonEmpty(workspaceId, fp, b, {
        engine: cached.manifest.engine ?? "file-tree",
      });
      return b;
    }
  }
  try {
    const t0 = Date.now();
    const rteResult = await generateBlueprint(scanRoot);
    if (rteResult && rteResult.nodes.length > 0) {
      const ignoreSrc =
        rteResult.atlarixIgnoreSource?.trim() ||
        (await readAtlarixIgnoreSource(scanRoot)).trim();
      const engine = blueprintEngineLabel(rteResult, {
        supplemented: rteResult.supplemented,
      });
      await saveBlueprintCache(scanRoot, {
        manifest: {
          projectPath: scanRoot,
          framework: rteResult.framework.name,
          language: rteResult.framework.name,
          engine,
        },
        nodes: rteResult.nodes,
        edges: rteResult.edges,
        ...(ignoreSrc ? { atlarixIgnoreSource: ignoreSrc } : {}),
      });
      const blueprint = rteResultToBlueprint(rteResult, scanRoot);
      if (blueprint.rooms.length > 0) {
        logger.info("inferBlueprint: generateBlueprint complete", {
          workspaceId,
          focusPath: fp,
          scanRoot,
          elapsedMs: Date.now() - t0,
          engine,
          nodes: rteResult.nodes.length,
          edges: rteResult.edges.length,
        });
        void import("@sentry/electron/main")
          .then((Sentry) => {
            Sentry.addBreadcrumb({
              category: "blueprint",
              message: "infer_generate_complete",
              level: "info",
              data: { workspaceId, focusPath: fp, elapsedMs: Date.now() - t0, engine },
            });
          })
          .catch(() => {});
        cacheBlueprintIfNonEmpty(workspaceId, fp, blueprint, { engine });
        return blueprint;
      }
    }
  } catch (e) {
    logger.warn("generateBlueprint failed, falling back to file-tree:", e);
  }
  try {
    const { rooms, edges, inferredEdges } = await buildBlueprintFromFileTree(scanRoot);
    const mergedEdges = [...edges, ...inferredEdges];
    const blueprint: Blueprint = { rooms, edges: mergedEdges, envRefs: [] };
    if (rooms.some((r) => !r.hidden && r.functions.length > 0)) {
      cacheBlueprintIfNonEmpty(workspaceId, fp, blueprint, { engine: "file-tree" });
      return blueprint;
    }
  } catch (e) {
    logger.warn("File-tree blueprint failed for section:", e);
  }
  if (fp === ".") {
    let analysis = (await getCachedAnalysis(workspacePath))?.analysis ?? null;
    if (!analysis) {
      try {
        analysis = await analyzeWorkspace(workspacePath);
      } catch (e) {
        logger.warn("blueprint infer failed:", e);
        return createEmptyBlueprint();
      }
    }
    return inferBlueprintFromWorkspace(analysis);
  }
  logger.warn("inferBlueprint: parse produced no rooms", {
    workspaceId,
    focusPath: fp,
    scanRoot,
  });
  return createEmptyBlueprint();
}

function normalizeFocusPrefix(p: string): string {
  return String(p || "")
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .toLowerCase();
}

/**
 * Narrow a full-workspace blueprint to rooms/functions under `focusPrefix`
 * (workspace-relative path prefix). Used for scoped tools without re-parsing.
 */
export function filterBlueprintByPathPrefix(blueprint: Blueprint, focusPrefix: string): Blueprint {
  const fp = normalizeFocusPrefix(focusPrefix);
  if (!fp) return blueprint;
  const roomOk = (r: BlueprintRoom) => {
    const rp = normalizeFocusPrefix(r.path ?? "");
    if (rp === fp || rp.startsWith(`${fp}/`)) return true;
    return (r.functions ?? []).some((fn) => {
      const f = normalizeFocusPrefix(fn.file ?? "");
      return f === fp || f.startsWith(`${fp}/`) || f.endsWith(`/${fp}`);
    });
  };
  const rooms = blueprint.rooms.filter(roomOk);
  const keep = new Set(rooms.map((r) => r.id));
  const edges = (blueprint.edges ?? []).filter((e) => keep.has(e.from) && keep.has(e.to));
  return { ...blueprint, rooms, edges, envRefs: blueprint.envRefs ?? [] };
}

/** Get blueprint for workspace section (memory → persisted → infer). Used by IPC and AI tools. */
export async function getBlueprintForWorkspace(
  workspaceId: number,
  options?: GetBlueprintOptions,
): Promise<Blueprint> {
  const fp = normalizeBlueprintFocusPath(options?.focusPath ?? ".") || ".";
  if (fp === "." && options?.allowWorkspaceRoot === false) {
    return createEmptyBlueprint();
  }

  const cacheKey = blueprintCacheKey(workspaceId, fp);
  const cached = getCachedBlueprint(workspaceId, fp);
  if (cached && countVisibleRooms(cached.blueprint) > 0) {
    touchBlueprintCache(cacheKey);
    const sanitized = sanitizeBlueprint(cached.blueprint);
    const needsFunctionBackfill = sanitized.rooms.some(
      (r) => (r.functions?.length ?? 0) === 0 && !r.hidden,
    );
    if (!cached.inferredEdgesMerged || needsFunctionBackfill) {
      const merged = await mergeInferredEdges(workspaceId, sanitized, fp);
      cacheBlueprintIfNonEmpty(workspaceId, fp, merged, { inferredEdgesMerged: true });
      return merged;
    }
    return sanitized;
  }
  const [app] = await db.select().from(apps).where(eq(apps.id, workspaceId)).limit(1);
  if (app && fp === ".") {
    const workspacePath = getAtlarixAppPath(app.path);
    void ensurePlansDir(workspacePath).catch(() => {});

    try {
      const snapshot = await loadBlueprintSnapshot(workspacePath);
      if (snapshot) {
        const cacheMtime = await getUserBlueprintMtime(workspacePath);
        const snapMtime = await getBlueprintSnapshotMtime(workspacePath);
        const shouldImport =
          cacheMtime == null || (snapMtime != null && snapMtime > cacheMtime);
        if (shouldImport) {
          const bp = snapshotToBlueprint(snapshot);
          const sanitized = sanitizeBlueprint(bp);
          setCachedBlueprint(workspaceId, fp, sanitized);
          try {
            await saveUserBlueprint(workspacePath, sanitized);
          } catch (persistErr) {
            logger.warn("[blueprint-snapshot] Failed to persist imported snapshot:", persistErr);
          }
          logSnapshotLoaded(snapshot);
          const merged = await mergeInferredEdges(workspaceId, sanitized, fp);
          setCachedBlueprint(workspaceId, fp, merged, { inferredEdgesMerged: true });
          return merged;
        }
      }
    } catch (snapErr) {
      logger.warn("[blueprint-snapshot] Auto-load failed (non-fatal):", snapErr);
    }

    const userBlueprint = await loadUserBlueprint(workspacePath);
    if (userBlueprint != null) {
      const base = sanitizeBlueprint(userBlueprint);
      const merged = await mergeInferredEdges(workspaceId, base, fp);
      setCachedBlueprint(workspaceId, fp, merged, { inferredEdgesMerged: true });
      return merged;
    }
  }
  const inferred = await inferBlueprint(workspaceId, fp);
  const sanitized = sanitizeBlueprint(inferred);
  const merged = await mergeInferredEdges(workspaceId, sanitized, fp);
  cacheBlueprintIfNonEmpty(workspaceId, fp, merged, { inferredEdgesMerged: true });
  return merged;
}

/** Merge inferred flow/cross-room edges from file tree when RTE graph is incomplete. */
async function mergeInferredEdges(
  workspaceId: number,
  blueprint: Blueprint,
  focusPath: string = ".",
): Promise<Blueprint> {
  const [app] = await db.select().from(apps).where(eq(apps.id, workspaceId)).limit(1);
  if (!app) return blueprint;

  const fp = normalizeBlueprintFocusPath(focusPath) || ".";
  const memEntry = getCachedBlueprint(workspaceId, fp);
  const workspacePath = getAtlarixAppPath(app.path);
  const scanRoot = resolveScanRoot(workspacePath, fp);
  const diskCache = await loadBlueprintCache(scanRoot);
  const engine = memEntry?.engine ?? diskCache?.manifest?.engine ?? "";

  try {
    const { rooms: inferredRooms, inferredEdges } = await buildBlueprintFromFileTree(scanRoot);
    return mergeBlueprintWithFileTree(blueprint, inferredRooms, inferredEdges, { engine });
  } catch (e) {
    logger.warn("mergeInferredEdges failed (non-fatal):", e);
    return blueprint;
  }
}

/** Set blueprint for workspace (in-memory + persist to disk); notifies renderer. Used by AI tools and UI save. */
export async function setBlueprintForWorkspace(workspaceId: number, blueprint: Blueprint): Promise<void> {
  const fp = ".";
  let b = sanitizeBlueprint(blueprint);
  b = await mergeInferredEdges(workspaceId, b, fp);
  const currentMerged = getCachedBlueprint(workspaceId, fp)?.blueprint;
  const [app] = await db.select().from(apps).where(eq(apps.id, workspaceId)).limit(1);
  if (app) {
    try {
      const workspacePath = getAtlarixAppPath(app.path);
      const previous = await loadUserBlueprint(workspacePath);
      const { rooms: inferredRooms, inferredEdges } = await buildBlueprintFromFileTree(workspacePath);
      const roomIds = new Set((b.rooms ?? []).map((r) => r.id));
      const inferredByRoomId = new Map(inferredRooms.map((r) => [r.id, r]));
      const inferredByKey = new Map(inferredRooms.map((r) => [normalizedRoomKey(r), r]));
      const inferredIdToBlueprintId = new Map<string, string>();
      for (const room of b.rooms ?? []) {
        const byId = inferredByRoomId.get(room.id);
        if (byId) {
          inferredIdToBlueprintId.set(room.id, room.id);
          continue;
        }
        const key = normalizedRoomKey(room);
        const byKey = inferredByKey.get(key);
        if (byKey) inferredIdToBlueprintId.set(byKey.id, room.id);
      }
      const mappedInferredKeys = (inferredEdges ?? [])
        .map((e) => {
          const fromId = inferredIdToBlueprintId.get(e.from) ?? e.from;
          const toId = inferredIdToBlueprintId.get(e.to) ?? e.to;
          return `${fromId}\t${toId}`;
        })
        .filter((key) => {
          const [fromId, toId] = key.split("\t");
          return roomIds.has(fromId) && roomIds.has(toId);
        });
      const currentEdgeKeys = new Set((b.edges ?? []).map((e) => `${e.from}\t${e.to}`));
      const previouslyShownKeys = currentMerged
        ? new Set((currentMerged.edges ?? []).map((e) => `${e.from}\t${e.to}`))
        : new Set<string>();
      const newlyRemoved = mappedInferredKeys.filter(
        (k) => previouslyShownKeys.has(k) && !currentEdgeKeys.has(k)
      );
      if (newlyRemoved.length > 0) {
        b = {
          ...b,
          removedInferredEdgeKeys: [...new Set([...(previous?.removedInferredEdgeKeys ?? []), ...newlyRemoved])],
        };
      }
      setCachedBlueprint(workspaceId, fp, b, { inferredEdgesMerged: true });
      await saveUserBlueprint(workspacePath, b);
      scheduleBlueprintChangeSnapshot(workspaceId, workspacePath, JSON.stringify(b));
    } catch (e) {
      logger.warn("Failed to persist user blueprint:", e);
      setCachedBlueprint(workspaceId, fp, b);
    }
  } else {
    setCachedBlueprint(workspaceId, fp, b);
  }
  sendToAllWindows("blueprint:updated", { workspaceId, blueprint: b });
}

/**
 * Invalidate blueprint cache for a workspace. Next getBlueprintForWorkspace will re-infer from code.
 * Call when diagram is regenerated or code structure changes.
 */
export function invalidateBlueprintCache(workspaceId: number, focusPath?: string): void {
  if (focusPath != null) {
    blueprintCache.delete(blueprintCacheKey(workspaceId, focusPath));
  } else {
    const prefix = `${workspaceId}:`;
    for (const key of [...blueprintCache.keys()]) {
      if (key.startsWith(prefix)) blueprintCache.delete(key);
    }
  }
  invalidateBm25Index(workspaceId);
  void (async () => {
    try {
      const [app] = await db.select().from(apps).where(eq(apps.id, workspaceId)).limit(1);
      if (app) invalidateSymbolIndex(getAtlarixAppPath(app.path));
    } catch {
      /* ignore */
    }
  })();
}

/** After diagram/code revert: drop cache, re-infer blueprint, push to all renderer windows (`blueprint:updated`). */
export async function broadcastBlueprintReload(workspaceId: number): Promise<void> {
  invalidateBlueprintCache(workspaceId);
  try {
    const blueprint = await getBlueprintForWorkspace(workspaceId, {
      focusPath: ".",
      allowWorkspaceRoot: true,
    });
    sendToAllWindows("blueprint:updated", { workspaceId, blueprint });
  } catch (e) {
    logger.warn("broadcastBlueprintReload failed:", e);
  }
}

export function registerBlueprintHandlers() {
  ipcMain.handle(
    "blueprint:get",
    async (_, { workspaceId }: { workspaceId: number }): Promise<{ success: boolean; blueprint?: Blueprint; error?: string }> => {
      try {
        const blueprint = await getBlueprintForWorkspace(workspaceId, {
          focusPath: ".",
          allowWorkspaceRoot: true,
        });
        const [app] = await db.select().from(apps).where(eq(apps.id, workspaceId)).limit(1);
        if (app) {
          const workspacePath = getAtlarixAppPath(app.path);
          // PASS8: Diagram generation is model-driven only. Auto-generation removed.
          // The file-system watcher used to call `runDiagramRegenerateBackground`
          // on every debounced workspace change, which kicked off a full LLM
          // regenerate + snapshot capture without any user / model intent.
          // We keep the watcher itself (so the Blueprint UI can refresh when
          // files change), but the callback is now a no-op as far as diagram
          // generation goes — callers must invoke `get_diagram` / the diagram
          // tool explicitly to refresh diagrams.
          registerBlueprintFileWatcher(workspacePath, workspaceId, async () => {
            // intentionally empty — see PASS8 note above
          });
          const [drow] = await db
            .select({ content: diagrams.content })
            .from(diagrams)
            .where(eq(diagrams.workspaceId, workspaceId))
            .limit(1);
          if (drow?.content?.trim()) {
            void ensureInitialDiagramSnapshot(workspacePath, drow.content);
          }
        }
        return { success: true, blueprint };
      } catch (error) {
        logger.error("blueprint:get error:", error);
        return {
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        };
      }
    }
  );

  ipcMain.handle(
    "blueprint:set",
    async (
      _,
      { workspaceId, blueprint }: { workspaceId: number; blueprint: Blueprint }
    ): Promise<{ success: boolean; error?: string }> => {
      await setBlueprintForWorkspace(workspaceId, blueprint);
      return { success: true };
    }
  );

  ipcMain.handle(
    "blueprint:get-atlarixignore",
    async (_, { workspaceId }: { workspaceId: number }) => {
      try {
        const [app] = await db.select().from(apps).where(eq(apps.id, workspaceId)).limit(1);
        if (!app) return { success: false, error: "Workspace not found" };
        const workspacePath = getAtlarixAppPath(app.path);
        await ensureDefaultAtlarixIgnore(workspacePath);
        const content = await readAtlarixIgnoreSource(workspacePath);
        return { success: true, content, filename: ATLARIX_IGNORE_FILENAME };
      } catch (e) {
        logger.error("blueprint:get-atlarixignore error:", e);
        return { success: false, error: e instanceof Error ? e.message : "Unknown error" };
      }
    },
  );

  ipcMain.handle(
    "blueprint:set-atlarixignore",
    async (_, { workspaceId, content }: { workspaceId: number; content: string }) => {
      try {
        const [app] = await db.select().from(apps).where(eq(apps.id, workspaceId)).limit(1);
        if (!app) return { success: false, error: "Workspace not found" };
        const workspacePath = getAtlarixAppPath(app.path);
        await fs.writeFile(getAtlarixIgnorePath(workspacePath), content, "utf-8");
        invalidateBlueprintCache(workspaceId);
        return { success: true };
      } catch (e) {
        logger.error("blueprint:set-atlarixignore error:", e);
        return { success: false, error: e instanceof Error ? e.message : "Unknown error" };
      }
    },
  );

  // v3.6: Reference projects for combined blueprint
  ipcMain.handle(
    "blueprint:get-reference-paths",
    async (_, { workspaceId }: { workspaceId: number }): Promise<{ success: boolean; paths?: string[]; error?: string }> => {
      try {
        const [app] = await db.select().from(apps).where(eq(apps.id, workspaceId)).limit(1);
        if (!app) return { success: false, error: "Workspace not found" };
        const workspacePath = getAtlarixAppPath(app.path);
        const paths = await getReferencePaths(workspacePath);
        return { success: true, paths };
      } catch (e) {
        logger.error("blueprint:get-reference-paths error:", e);
        return { success: false, error: e instanceof Error ? e.message : "Unknown error" };
      }
    }
  );
  ipcMain.handle(
    "blueprint:set-reference-paths",
    async (
      _,
      { workspaceId, paths }: { workspaceId: number; paths: string[] }
    ): Promise<{ success: boolean; error?: string }> => {
      try {
        const [app] = await db.select().from(apps).where(eq(apps.id, workspaceId)).limit(1);
        if (!app) return { success: false, error: "Workspace not found" };
        const workspacePath = getAtlarixAppPath(app.path);
        await setReferencePaths(workspacePath, paths);
        invalidateBlueprintCache(workspaceId);
        return { success: true };
      } catch (e) {
        logger.error("blueprint:set-reference-paths error:", e);
        return { success: false, error: e instanceof Error ? e.message : "Unknown error" };
      }
    }
  );

  // blueprint:refresh-from-code - Run full RTE, merge with current (keep positions, replace inferred edges), save, emit
  ipcMain.handle(
    "blueprint:refresh-from-code",
    async (
      _,
      { workspaceId }: { workspaceId: number }
    ): Promise<{ success: boolean; blueprint?: Blueprint; newConnectionsCount?: number; error?: string }> => {
      try {
        sendToAllWindows("blueprint:rte-running", { workspaceId, running: true });
        const [app] = await db.select().from(apps).where(eq(apps.id, workspaceId)).limit(1);
        if (!app) {
          sendToAllWindows("blueprint:rte-running", { workspaceId, running: false });
          return { success: false, error: "Workspace not found" };
        }
        const workspacePath = getAtlarixAppPath(app.path);
        const fp = ".";
        const current =
          getCachedBlueprint(workspaceId, fp)?.blueprint ??
          (await loadUserBlueprint(workspacePath)) ??
          createEmptyBlueprint();
        let merged: Blueprint;
        try {
          const rteResult = await generateBlueprint(workspacePath);
          if (rteResult && rteResult.nodes.length > 0) {
            const ignoreSrc =
              rteResult.atlarixIgnoreSource?.trim() ||
              (await readAtlarixIgnoreSource(workspacePath)).trim();
            await saveBlueprintCache(workspacePath, {
              manifest: {
                projectPath: workspacePath,
                framework: rteResult.framework.name,
                language: rteResult.framework.name,
                engine: blueprintEngineLabel(rteResult),
              },
              nodes: rteResult.nodes,
              edges: rteResult.edges,
              ...(ignoreSrc ? { atlarixIgnoreSource: ignoreSrc } : {}),
            });
            const fromRte = rteResultToBlueprint(rteResult, workspacePath);
            const nonInferredEdges = (current.edges ?? []).filter((e) => !e.inferred);
            const edgeMap = new Map<string, Blueprint["edges"][0]>();
            for (const e of nonInferredEdges) edgeMap.set(`${e.from}\t${e.to}`, e);
            for (const e of fromRte.edges) edgeMap.set(`${e.from}\t${e.to}`, { ...e, inferred: false });
            const added = fromRte.edges.filter(
              (e) => !(current.edges ?? []).some((c) => c.from === e.from && c.to === e.to)
            );
            merged = {
              rooms: fromRte.rooms.map((r) => {
                const existing = current.rooms.find((er) => er.id === r.id);
                return existing ? { ...r, ...(existing.path && { path: existing.path }) } : r;
              }),
              edges: Array.from(edgeMap.values()),
              envRefs: current.envRefs ?? [],
            };
            const mergedWithInferred = await mergeInferredEdges(workspaceId, merged, fp);
            setCachedBlueprint(workspaceId, fp, mergedWithInferred, { inferredEdgesMerged: true });
            await saveUserBlueprint(workspacePath, mergedWithInferred);
            sendToAllWindows("blueprint:updated", { workspaceId, blueprint: mergedWithInferred });
            sendToAllWindows("blueprint:rte-running", { workspaceId, running: false });
            return { success: true, blueprint: mergedWithInferred, newConnectionsCount: added.length };
          }
        } catch (e) {
          logger.warn("RTE refresh failed, falling back to file-tree:", e);
        }
        const fileTree = await buildBlueprintFromFileTree(workspacePath);
        merged = {
          rooms: fileTree.rooms,
          edges: [...fileTree.edges, ...fileTree.inferredEdges],
          envRefs: current.envRefs ?? [],
        };
        const mergedWithInferred = await mergeInferredEdges(workspaceId, merged, fp);
        setCachedBlueprint(workspaceId, fp, mergedWithInferred, { inferredEdgesMerged: true });
        sendToAllWindows("blueprint:updated", { workspaceId, blueprint: mergedWithInferred });
        sendToAllWindows("blueprint:rte-running", { workspaceId, running: false });
        return { success: true, blueprint: mergedWithInferred, newConnectionsCount: 0 };
      } catch (error) {
        sendToAllWindows("blueprint:rte-running", { workspaceId, running: false });
        logger.error("blueprint:refresh-from-code error:", error);
        return {
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        };
      }
    }
  );

  ipcMain.handle(
    "blueprint:analyze-workspace",
    async (_, { workspaceId }: { workspaceId: number }): Promise<{ success: boolean; projects?: ProjectCandidate[]; error?: string }> => {
      try {
        const [app] = await db.select().from(apps).where(eq(apps.id, workspaceId)).limit(1);
        if (!app) return { success: false, error: "Workspace not found" };
        const workspacePath = getAtlarixAppPath(app.path);
        const projects = await analyzeWorkspaceWithActivity(workspacePath);
        return { success: true, projects };
      } catch (error) {
        logger.error("blueprint:analyze-workspace error:", error);
        return { success: false, error: error instanceof Error ? error.message : "Unknown error" };
      }
    }
  );

  ipcMain.handle(
    "blueprint:generate-combined",
    async (
      _,
      { workspaceId, projectIds }: { workspaceId: number; projectIds: string[] }
    ): Promise<{ success: boolean; combined?: CombinedBlueprint; blueprint?: Blueprint; error?: string }> => {
      try {
        const [app] = await db.select().from(apps).where(eq(apps.id, workspaceId)).limit(1);
        if (!app) return { success: false, error: "Workspace not found" };
        const workspacePath = getAtlarixAppPath(app.path);
        const allProjects = await analyzeWorkspaceWithActivity(workspacePath);
        const selected = allProjects.filter((p) => projectIds.includes(p.id));
        if (selected.length === 0) return { success: false, error: "No projects selected" };
        const combined = await generateCombinedBlueprint(selected);
        let blueprintToSet: Blueprint = createEmptyBlueprint();
        if (combined.projects.length === 1) {
          const projectPath = selected[0].path;
          const rteResult = await generateBlueprint(projectPath);
          if (rteResult && rteResult.nodes.length > 0) {
            blueprintToSet = rteResultToBlueprint(rteResult, projectPath);
            setBlueprintForWorkspace(workspaceId, blueprintToSet);
          }
        }
        return { success: true, combined, blueprint: blueprintToSet };
      } catch (error) {
        logger.error("blueprint:generate-combined error:", error);
        return { success: false, error: error instanceof Error ? error.message : "Unknown error" };
      }
    }
  );

  ipcMain.handle(
    "blueprint:codegen",
    async (
      _,
      { workspaceId, delta }: { workspaceId: number; delta: CodegenDelta }
    ): Promise<{ success: boolean; result?: CodegenResult; error?: string }> => {
      try {
        const app = await db.query.apps.findFirst({
          where: eq(apps.id, workspaceId),
        });
        if (!app) {
          return { success: false, error: "Workspace not found" };
        }
        const workspacePath = getAtlarixAppPath(app.path);
        const result = await generateFromBlueprintDelta(workspacePath, delta);
        logger.info("blueprint:codegen ok", { workspaceId, filesCreated: result.filesCreated.length, envKeysAdded: result.envKeysAdded.length });
        return { success: true, result };
      } catch (error) {
        logger.error("blueprint:codegen error:", error);
        return {
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        };
      }
    }
  );

  ipcMain.handle(
    "blueprint:simplify-description",
    async (
      _,
      { workspaceId, roomId, functionId }: { workspaceId: number; roomId: string; functionId: string }
    ): Promise<{ success: boolean; simpleDescription?: string; error?: string }> => {
      try {
        const blueprint = await getBlueprintForWorkspace(workspaceId, {
          focusPath: ".",
          allowWorkspaceRoot: true,
        });
        const room = blueprint.rooms.find((r) => r.id === roomId);
        const fn = room?.functions.find((f) => f.id === functionId);
        if (!fn) {
          return { success: false, error: "Function not found" };
        }
        const simpleDescription = await simplifyDescriptionWithAI(
          fn.name,
          fn.kind,
          fn.description
        );
        if (!simpleDescription) {
          return { success: false, error: "Could not generate description" };
        }
        const updatedRooms = blueprint.rooms.map((r) =>
          r.id !== roomId
            ? r
            : {
                ...r,
                functions: r.functions.map((f) =>
                  f.id !== functionId
                    ? f
                    : { ...f, simpleDescription, descriptionSource: "ai" as const },
                ),
              }
        );
        await setBlueprintForWorkspace(workspaceId, { ...blueprint, rooms: updatedRooms });
        return { success: true, simpleDescription };
      } catch (error) {
        logger.error("blueprint:simplify-description error:", error);
        return {
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        };
      }
    }
  );

  ipcMain.handle(
    "blueprint:simplify-room",
    async (
      _,
      { workspaceId, roomId }: { workspaceId: number; roomId: string }
    ): Promise<{ success: boolean; label?: string; intent?: string; error?: string }> => {
      try {
        const blueprint = await getBlueprintForWorkspace(workspaceId, {
          focusPath: ".",
          allowWorkspaceRoot: true,
        });
        const room = blueprint.rooms.find((r) => r.id === roomId);
        if (!room) {
          return { success: false, error: "Room not found" };
        }
        const functionNames = room.functions.map((f) => f.name);
        const suggested = await simplifyRoomWithAI(room.label, room.path, functionNames);
        if (!suggested) {
          return { success: false, error: "Could not generate description" };
        }
        const updatedRooms = blueprint.rooms.map((r) =>
          r.id !== roomId ? r : { ...r, label: suggested, intent: r.intent ?? suggested }
        );
        await setBlueprintForWorkspace(workspaceId, { ...blueprint, rooms: updatedRooms });
        return { success: true, label: suggested, intent: suggested };
      } catch (error) {
        logger.error("blueprint:simplify-room error:", error);
        return {
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        };
      }
    }
  );

  ipcMain.handle(
    "blueprint:simplify-architecture",
    async (_, { workspaceId }: { workspaceId: number }): Promise<{ success: boolean; summary?: string; error?: string }> => {
      try {
        const blueprint = await getBlueprintForWorkspace(workspaceId, {
          focusPath: ".",
          allowWorkspaceRoot: true,
        });
        const roomLabels = (blueprint.rooms ?? []).filter((r) => !r.hidden).map((r) => r.label);
        const edgeCount = (blueprint.edges ?? []).length;
        const summary = await simplifyArchitectureWithAI(roomLabels, edgeCount);
        if (!summary) {
          return { success: false, error: "Could not generate summary" };
        }
        return { success: true, summary };
      } catch (error) {
        logger.error("blueprint:simplify-architecture error:", error);
        return {
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        };
      }
    }
  );

  // Workforce Feature 2: commit the current Blueprint to `.atlarix/blueprint.json`.
  // Gated to Workforce tier; non-Workforce callers receive a structured error.
  ipcMain.handle(
    "blueprint:commit-snapshot",
    async (
      _,
      { workspaceId }: { workspaceId: number },
    ): Promise<{
      success: boolean;
      nodeCount?: number;
      edgeCount?: number;
      path?: string;
      firstCommit?: boolean;
      error?: string;
    }> => {
      try {
        if (SubscriptionManager.getEffectiveTier() !== "workforce") {
          return {
            success: false,
            error: "Blueprint commits are a Workforce feature.",
          };
        }
        const [appRow] = await db.select().from(apps).where(eq(apps.id, workspaceId)).limit(1);
        if (!appRow) return { success: false, error: "Workspace not found" };

        const workspacePath = getAtlarixAppPath(appRow.path);
        const blueprint = await getBlueprintForWorkspace(workspaceId, {
          focusPath: ".",
          allowWorkspaceRoot: true,
        });

        let lastCommitHash: string | undefined;
        try {
          lastCommitHash = await getCurrentCommitHash({ path: workspacePath });
        } catch (e) {
          logger.warn("[blueprint-snapshot] No git HEAD (continuing):", e);
        }

        const result = await snapshotBlueprintToRepo({
          workspacePath,
          blueprint,
          workspaceName: appRow.name,
          atlarixVersion: electronApp.getVersion(),
          lastCommitHash,
        });

        return {
          success: true,
          nodeCount: result.nodeCount,
          edgeCount: result.edgeCount,
          path: result.path,
          firstCommit: result.firstCommit,
        };
      } catch (error) {
        logger.error("blueprint:commit-snapshot error:", error);
        return {
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        };
      }
    },
  );

  // Read-only on all tiers — used by the renderer to decide whether to surface
  // the "Blueprint loaded from snapshot" badge.
  ipcMain.handle(
    "blueprint:snapshot-exists",
    async (
      _,
      { workspaceId }: { workspaceId: number },
    ): Promise<{
      exists: boolean;
      snapshot?: { nodeCount: number; edgeCount: number; generatedAt: string };
      error?: string;
    }> => {
      try {
        const [appRow] = await db.select().from(apps).where(eq(apps.id, workspaceId)).limit(1);
        if (!appRow) return { exists: false };
        const workspacePath = getAtlarixAppPath(appRow.path);
        const exists = await blueprintSnapshotExists(workspacePath);
        if (!exists) return { exists: false };
        const snap = await loadBlueprintSnapshot(workspacePath);
        if (!snap) return { exists: true };
        return {
          exists: true,
          snapshot: {
            nodeCount: snap.nodeCount,
            edgeCount: snap.edgeCount,
            generatedAt: snap.generatedAt,
          },
        };
      } catch (error) {
        logger.error("blueprint:snapshot-exists error:", error);
        return {
          exists: false,
          error: error instanceof Error ? error.message : "Unknown error",
        };
      }
    },
  );

}
