/**
 * Blueprint IPC Handlers (Phase 7 Additive Blueprint)
 * ===================================================
 * Blueprints are not persisted. In-memory cache per workspace
 * so AI tools and UI share current state; blueprint:updated notifies the renderer.
 */

import { existsSync } from "node:fs";
import { db } from "@/db";
import { apps } from "@/db/schema";
import { eq } from "drizzle-orm";
import type { Blueprint } from "@/shared/blueprint-types";
import { createEmptyBlueprint } from "@/shared/blueprint-types";
import { getAtlarixAppPath } from "@/paths/paths";
import { loadBlueprintCache, saveBlueprintCache, saveUserBlueprint, loadUserBlueprint, getUserBlueprintMtime } from "@/lib/cache/blueprint-cache";
import {
  composeIgnoreSource,
  createIgnorerFromSource,
  filterRteEdgesByNodes,
  filterRteNodesByIgnore,
  loadIgnorerForProject,
} from "@/lib/atlarix/atlarix-ignore";
import { inferBlueprintFromWorkspace } from "@/lib/blueprint/workspace_to_blueprint";
import { rteResultToBlueprint } from "@/lib/blueprint/rte_to_blueprint";
import { generateBlueprint, blueprintEngineLabel } from "@/lib/blueprint/rte/parsers";
import { buildBlueprintFromFileTree } from "@/lib/blueprint/fileTreeSource";
import { mergeBlueprintWithFileTree } from "@/lib/blueprint/blueprint-merge";
import { countVisibleRooms } from "@/lib/blueprint/blueprint-slice";
import { markBlueprintSliceDirty } from "@/lib/blueprint/blueprint-slice-cache";
import { validateBlueprintFocusPath } from "@/lib/blueprint/section-path";
import { getCachedAnalysis } from "@/lib/analysis/workspace-cache";
import { analyzeWorkspace } from "@/lib/analysis/workspace-analyzer";
import log from "electron-log";
import { invalidateBm25Index, markBm25Dirty } from "@/lib/search/bm25_semantic_index";
import {
  getBlueprintSnapshotMtime,
  loadBlueprintSnapshot,
  logSnapshotLoaded,
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
  engine?: "ast-grep+ctags" | "ctags-only" | "file-tree" | "hybrid";
  /** v12 S20: unresolved (non-identifier-callee) call sites from the parse. */
  dynamicCallCount?: number;
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
  options?: {
    inferredEdgesMerged?: boolean;
    engine?: "ast-grep+ctags" | "ctags-only" | "file-tree" | "hybrid";
    dynamicCallCount?: number;
  },
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
    dynamicCallCount: options?.dynamicCallCount ?? prev?.dynamicCallCount,
  });
  markBm25Dirty(workspaceId);
  markBlueprintSliceDirty(workspaceId); // v12 Tier 6 #5: drop cached slices on reparse
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

function cacheBlueprintIfNonEmpty(
  workspaceId: number,
  focusPath: string,
  blueprint: Blueprint,
  options?: {
    inferredEdgesMerged?: boolean;
    engine?: "ast-grep+ctags" | "ctags-only" | "file-tree" | "hybrid";
    dynamicCallCount?: number;
  },
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

  // Guard the scan-root existence for EVERY path, including fp === "." (a moved/
  // deleted workspace) — the fp !== "." branch below only validates sub-paths, so
  // without this a missing root reached the scan and logged "scan root does not
  // exist" downstream. Return empty cleanly instead.
  if (!existsSync(scanRoot)) {
    logger.warn("inferBlueprint: scan root does not exist", {
      workspaceId,
      focusPath: fp,
      scanRoot,
    });
    return createEmptyBlueprint();
  }

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
        dynamicCallCount: cached.manifest.dynamicCallCount, // v12 S20
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
        (await composeIgnoreSource(scanRoot)).trim();
      const engine = blueprintEngineLabel(rteResult, {
        supplemented: rteResult.supplemented,
      });
      await saveBlueprintCache(scanRoot, {
        manifest: {
          projectPath: scanRoot,
          framework: rteResult.framework.name,
          language: rteResult.framework.name,
          engine,
          ...(rteResult.dynamicCallCount != null
            ? { dynamicCallCount: rteResult.dynamicCallCount } // v12 S20
            : {}),
        },
        nodes: rteResult.nodes,
        edges: rteResult.edges,
        ...(ignoreSrc ? { atlarixIgnoreSource: ignoreSrc } : {}),
      });
      const blueprint = rteResultToBlueprint(rteResult, scanRoot);
      if (blueprint.rooms.length > 0) {
        logger.debug("inferBlueprint: generateBlueprint complete", {
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
        cacheBlueprintIfNonEmpty(workspaceId, fp, blueprint, {
          engine,
          dynamicCallCount: rteResult.dynamicCallCount, // v12 S20
        });
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

