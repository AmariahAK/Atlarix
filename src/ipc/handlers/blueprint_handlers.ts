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
import type { Blueprint, CombinedBlueprint } from "@/shared/blueprint-types";
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
import { loadBlueprintCache, saveBlueprintCache, saveUserBlueprint, loadUserBlueprint } from "@/lib/cache/blueprint-cache";
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
import { generateBlueprint } from "@/lib/blueprint/rte/parsers";
import { buildBlueprintFromFileTree } from "@/lib/blueprint/fileTreeSource";
import { getReferencePaths, setReferencePaths, buildCombinedBlueprint, saveCombinedBlueprint } from "@/lib/blueprint/reference-manager";
import { enrichAll } from "@/lib/blueprint/enricher";
import { ensurePlansDir } from "@/lib/plans/plan-manager";
import * as fs from "node:fs/promises";
import { getCachedAnalysis } from "@/lib/analysis/workspace-cache";
import { analyzeWorkspace } from "@/lib/analysis/workspace-analyzer";
import { simplifyDescriptionWithAI, simplifyRoomWithAI, simplifyArchitectureWithAI } from "@/lib/blueprint/descriptions/aiSimplifier";
import { layoutContainerCanvas, layoutBeaconFlow } from "@/lib/blueprint/layoutEngine";
import { parseProject } from "@/lib/pivot/parsers";
import {
  saveNodesAndEdges,
  saveBlueprintSnapshot,
  saveContainersAndBeacons,
  loadNodesAndEdges,
  loadBlueprintSnapshots,
  getBlueprintSnapshot,
} from "@/lib/pivot/pivot-service";
import { clusterIntoContainers } from "@/lib/pivot/clustering";
import log from "electron-log";

const logger = log.scope("blueprint_handlers");

const blueprintCache = new Map<number, Blueprint>();

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

/** Persist PIVOT: parse project, save nodes/edges and a blueprint snapshot (source: rte). */
async function persistPivotFromRefresh(
  workspaceId: number,
  workspacePath: string,
  blueprint: Blueprint,
): Promise<void> {
  try {
    const parsed = await parseProject(workspacePath);
    await saveNodesAndEdges(workspaceId, parsed.nodes, parsed.edges);
    await saveBlueprintSnapshot(workspaceId, JSON.stringify(blueprint), "rte");
  } catch (e) {
    throw e;
  }
}

/** Infer blueprint when no user blueprint: RTE cache first, then file-tree (no full RTE). */
async function inferBlueprint(workspaceId: number): Promise<Blueprint> {
  const [app] = await db.select().from(apps).where(eq(apps.id, workspaceId)).limit(1);
  if (!app) return createEmptyBlueprint();
  const workspacePath = getAtlarixAppPath(app.path);
  const cached = await loadBlueprintCache(workspacePath);
  if (cached && cached.nodes.length > 0) {
    const ig = cached.atlarixIgnoreSource?.trim()
      ? createIgnorerFromSource(cached.atlarixIgnoreSource)
      : await loadIgnorerForProject(workspacePath);
    const nodes = filterRteNodesByIgnore(cached.nodes, ig, workspacePath);
    const kept = new Set(nodes.map((n) => n.id));
    const edges = filterRteEdgesByNodes(cached.edges, kept);
    const b = rteResultToBlueprint(
      {
        nodes,
        edges,
        framework: { name: cached.manifest.framework, confidence: 0.8 },
      },
      workspacePath
    );
    if (b.rooms.length > 0) return b;
  }
  try {
    const { rooms, edges, inferredEdges } = await buildBlueprintFromFileTree(workspacePath);
    const mergedEdges = [...edges, ...inferredEdges];
    const blueprint: Blueprint = { rooms, edges: mergedEdges, envRefs: [] };
    if (rooms.some((r) => !r.hidden && r.functions.length > 0)) {
      // v3.6: Background combined blueprint + enrichment; emit when done
      void (async () => {
        try {
          const refPaths = await getReferencePaths(workspacePath);
          if (refPaths.length > 0) {
            const combined = await buildCombinedBlueprint(workspacePath, refPaths);
            await saveCombinedBlueprint(workspacePath, combined);
          }
          await enrichAll(workspacePath, rooms, (p) => fs.readFile(p, "utf-8"));
          sendToAllWindows("blueprint:updated", { workspaceId, blueprint });
        } catch (e) {
          logger.warn("Background enrichment/combined failed:", e);
        }
      })();
      return blueprint;
    }
  } catch (e) {
    logger.warn("File-tree blueprint failed, falling back to workspace analysis:", e);
  }
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

/** Get blueprint for workspace (memory, then persisted user blueprint, then infer). Used by IPC and AI tools. */
export async function getBlueprintForWorkspace(workspaceId: number): Promise<Blueprint> {
  const cached = blueprintCache.get(workspaceId);
  if (cached) {
    const sanitized = sanitizeBlueprint(cached);
    const needsFunctionBackfill = sanitized.rooms.some(
      (r) => (r.functions?.length ?? 0) === 0 && !r.hidden,
    );
    if (needsFunctionBackfill) {
      const merged = await mergeInferredEdges(workspaceId, sanitized);
      blueprintCache.set(workspaceId, merged);
      return merged;
    }
    return sanitized;
  }
  const [app] = await db.select().from(apps).where(eq(apps.id, workspaceId)).limit(1);
  if (app) {
    const workspacePath = getAtlarixAppPath(app.path);
    void ensurePlansDir(workspacePath).catch(() => {});
    const userBlueprint = await loadUserBlueprint(workspacePath);
    if (userBlueprint != null) {
      const base = sanitizeBlueprint(userBlueprint);
      const merged = await mergeInferredEdges(workspaceId, base);
      blueprintCache.set(workspaceId, merged);
      return merged;
    }
  }
  const inferred = await inferBlueprint(workspaceId);
  const sanitized = sanitizeBlueprint(inferred);
  blueprintCache.set(workspaceId, sanitized);
  return sanitized;
}

/** Normalize room label for matching (lowercase, trim, collapse spaces to underscore). */
function normalizedRoomKey(room: { label: string; path?: string }): string {
  const s = (room.label ?? "").trim().toLowerCase().replace(/\s+/g, "_").replace(/[^a-z0-9_-]/g, "_");
  return s || "_";
}

/** Merge inferred flow/cross-room edges from file tree into an existing blueprint so users can see and edit connections. */
async function mergeInferredEdges(workspaceId: number, blueprint: Blueprint): Promise<Blueprint> {
  const [app] = await db.select().from(apps).where(eq(apps.id, workspaceId)).limit(1);
  if (!app) return blueprint;
  try {
    const workspacePath = getAtlarixAppPath(app.path);
    const { rooms: inferredRooms, inferredEdges } = await buildBlueprintFromFileTree(workspacePath);
    const roomIds = new Set((blueprint.rooms ?? []).map((r) => r.id));
    const existingEdgeKeys = new Set((blueprint.edges ?? []).map((e) => `${e.from}\t${e.to}`));

    const inferredByRoomId = new Map(inferredRooms.map((r) => [r.id, r]));
    const inferredByKey = new Map(inferredRooms.map((r) => [normalizedRoomKey(r), r]));

    const inferredIdToBlueprintId = new Map<string, string>();
    for (const room of blueprint.rooms ?? []) {
      const byId = inferredByRoomId.get(room.id);
      if (byId) {
        inferredIdToBlueprintId.set(room.id, room.id);
        continue;
      }
      const key = normalizedRoomKey(room);
      const byKey = inferredByKey.get(key);
      if (byKey) inferredIdToBlueprintId.set(byKey.id, room.id);
    }

    const newCrossRoom = (inferredEdges ?? [])
      .map((e) => {
        const fromId = inferredIdToBlueprintId.get(e.from) ?? e.from;
        const toId = inferredIdToBlueprintId.get(e.to) ?? e.to;
        return { ...e, from: fromId, to: toId };
      })
      .filter(
        (e) =>
          roomIds.has(e.from) &&
          roomIds.has(e.to) &&
          !existingEdgeKeys.has(`${e.from}\t${e.to}`) &&
          !(blueprint.removedInferredEdgeKeys ?? []).includes(`${e.from}\t${e.to}`)
      );

    const rooms = (blueprint.rooms ?? []).map((room) => {
      const inferredRoom = inferredByRoomId.get(room.id) ?? inferredByKey.get(normalizedRoomKey(room));
      const effectiveFunctions =
        (room.functions?.length ?? 0) > 0 ? room.functions : (inferredRoom?.functions ?? []);
      let nextRoom = { ...room, functions: effectiveFunctions };

      if (!inferredRoom?.flowEdges?.length) return nextRoom;

      const existingFlowKeys = new Set((nextRoom.flowEdges ?? []).map((e) => `${e.from}\t${e.to}`));
      const roomFnByName = new Map(nextRoom.functions.map((f) => [f.name, f]));
      const roomFnByFile = new Map(
        nextRoom.functions.filter((f) => f.file).map((f) => [path.normalize(f.file!).replace(/\\/g, "/"), f])
      );
      const roomFnByBasename = new Map(
        nextRoom.functions.map((f) => [f.name.toLowerCase(), f])
      );
      const inferredToRoomFnId = new Map<string, string>();
      for (const inf of inferredRoom.functions) {
        const byFile = inf.file ? roomFnByFile.get(path.normalize(inf.file).replace(/\\/g, "/")) : undefined;
        const byName = roomFnByName.get(inf.name);
        const basenameFromId = inf.id.includes("::") ? inf.id.split("::").pop()! : inf.name;
        const byBasename = roomFnByBasename.get(basenameFromId.toLowerCase());
        const roomFn = byFile ?? byName ?? byBasename;
        if (roomFn) inferredToRoomFnId.set(inf.id, roomFn.id);
      }

      const added: typeof nextRoom.flowEdges = [];
      for (const e of inferredRoom.flowEdges) {
        const fromId = inferredToRoomFnId.get(e.from);
        const toId = inferredToRoomFnId.get(e.to);
        if (fromId && toId && !existingFlowKeys.has(`${fromId}\t${toId}`)) {
          added.push({ ...e, from: fromId, to: toId });
          existingFlowKeys.add(`${fromId}\t${toId}`);
        }
      }
      if (added.length === 0) return nextRoom;
      return { ...nextRoom, flowEdges: [...(nextRoom.flowEdges ?? []), ...added] };
    });

    const edges = [...(blueprint.edges ?? []), ...newCrossRoom];
    return { ...blueprint, rooms, edges };
  } catch (e) {
    logger.warn("mergeInferredEdges failed (non-fatal):", e);
    return blueprint;
  }
}

/** Set blueprint for workspace (in-memory + persist to disk); notifies renderer. Used by AI tools and UI save. */
export async function setBlueprintForWorkspace(workspaceId: number, blueprint: Blueprint): Promise<void> {
  let b = sanitizeBlueprint(blueprint);
  b = await mergeInferredEdges(workspaceId, b);
  const currentMerged = blueprintCache.get(workspaceId);
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
      blueprintCache.set(workspaceId, b);
      await saveUserBlueprint(workspacePath, b);
      await saveBlueprintSnapshot(workspaceId, JSON.stringify(b), "user");
      scheduleBlueprintChangeSnapshot(workspaceId, workspacePath, JSON.stringify(b));
    } catch (e) {
      logger.warn("Failed to persist user blueprint:", e);
      blueprintCache.set(workspaceId, b);
    }
  } else {
    blueprintCache.set(workspaceId, b);
  }
  sendToAllWindows("blueprint:updated", { workspaceId, blueprint: b });
}

/**
 * Invalidate blueprint cache for a workspace. Next getBlueprintForWorkspace will re-infer from code.
 * Call when diagram is regenerated or code structure changes.
 */
export function invalidateBlueprintCache(workspaceId: number): void {
  blueprintCache.delete(workspaceId);
}

/** After diagram/code revert: drop cache, re-infer blueprint, push to all renderer windows (`blueprint:updated`). */
export async function broadcastBlueprintReload(workspaceId: number): Promise<void> {
  invalidateBlueprintCache(workspaceId);
  try {
    const blueprint = await getBlueprintForWorkspace(workspaceId);
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
        const blueprint = await getBlueprintForWorkspace(workspaceId);
        const [app] = await db.select().from(apps).where(eq(apps.id, workspaceId)).limit(1);
        if (app) {
          const workspacePath = getAtlarixAppPath(app.path);
          registerBlueprintFileWatcher(workspacePath, workspaceId, async (projPath, rel, wid) => {
            const { readSettings } = await import("@/main/settings");
            if (readSettings().selectedChatMode === "ask") return;
            const { runDiagramRegenerateBackground } = await import(
              "@/ipc/handlers/diagram_regenerate_background"
            );
            const regen = await runDiagramRegenerateBackground(wid);
            if (!regen.success || ("skipped" in regen && regen.skipped)) return;
            try {
              const [drow] = await db
                .select({ content: diagrams.content })
                .from(diagrams)
                .where(eq(diagrams.workspaceId, wid))
                .limit(1);
              const raw = drow?.content?.trim();
              if (!raw) return;
              const mermaid = extractMermaidFromMarkdown(raw) ?? raw;
              const md = buildRichDiagramMarkdown({
                mermaidBody: mermaid,
                promptLine: `Debounced file watch — ${rel}`,
              });
              await captureSnapshot({
                workspacePath: projPath,
                turnId: "fs-watch",
                relativePaths: [],
                diagramBefore: md,
                promptSummary: `fs-watch:${rel}`,
              });
            } catch (e) {
              logger.warn("fs-watch diagram snapshot skipped:", e);
            }
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
        const current = blueprintCache.get(workspaceId) ?? (await loadUserBlueprint(workspacePath)) ?? createEmptyBlueprint();
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
            blueprintCache.set(workspaceId, merged);
            await saveUserBlueprint(workspacePath, merged);
            sendToAllWindows("blueprint:updated", { workspaceId, blueprint: merged });
            sendToAllWindows("blueprint:rte-running", { workspaceId, running: false });
            persistPivotFromRefresh(workspaceId, workspacePath, merged).catch((e) =>
              logger.warn("PIVOT persist after RTE failed (non-fatal):", e)
            );
            return { success: true, blueprint: merged, newConnectionsCount: added.length };
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
        blueprintCache.set(workspaceId, merged);
        sendToAllWindows("blueprint:updated", { workspaceId, blueprint: merged });
        sendToAllWindows("blueprint:rte-running", { workspaceId, running: false });
        persistPivotFromRefresh(workspaceId, workspacePath, merged).catch((e) =>
          logger.warn("PIVOT persist after file-tree failed (non-fatal):", e)
        );
        return { success: true, blueprint: merged, newConnectionsCount: 0 };
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
        const blueprint = await getBlueprintForWorkspace(workspaceId);
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
        const blueprint = await getBlueprintForWorkspace(workspaceId);
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
        const blueprint = await getBlueprintForWorkspace(workspaceId);
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

  ipcMain.handle(
    "blueprint:layout-containers",
    async (_, { rooms, edges }: { rooms: Array<{ id: string }>; edges: Array<{ id: string; from: string; to: string }> }) => {
      return layoutContainerCanvas(rooms, edges, rooms.length);
    }
  );

  ipcMain.handle(
    "blueprint:layout-beacons",
    async (_, { beacons, flowEdges }: { beacons: Array<{ id: string }>; flowEdges: Array<{ id: string; from: string; to: string }> }) => {
      return layoutBeaconFlow(beacons, flowEdges);
    }
  );

  ipcMain.handle(
    "pivot:get-nodes-edges",
    async (_, { workspaceId }: { workspaceId: number }) => {
      try {
        const { nodes, edges } = await loadNodesAndEdges(workspaceId);
        return { success: true, nodes, edges };
      } catch (error) {
        logger.error("pivot:get-nodes-edges error:", error);
        return { success: false, error: error instanceof Error ? error.message : "Unknown error" };
      }
    }
  );

  ipcMain.handle(
    "pivot:get-snapshots",
    async (_, { workspaceId, limit }: { workspaceId: number; limit?: number }) => {
      try {
        const snapshots = await loadBlueprintSnapshots(workspaceId, limit ?? 50);
        return { success: true, snapshots };
      } catch (error) {
        logger.error("pivot:get-snapshots error:", error);
        return { success: false, error: error instanceof Error ? error.message : "Unknown error" };
      }
    }
  );

  ipcMain.handle(
    "pivot:restore-snapshot",
    async (_, { workspaceId, snapshotId }: { workspaceId: number; snapshotId: number }) => {
      try {
        const data = await getBlueprintSnapshot(snapshotId);
        if (!data || data.workspaceId !== workspaceId) {
          return { success: false, error: "Snapshot not found" };
        }
        const blueprint = JSON.parse(data.blueprintJson) as Blueprint;
        await setBlueprintForWorkspace(workspaceId, blueprint);
        return { success: true, blueprint };
      } catch (error) {
        logger.error("pivot:restore-snapshot error:", error);
        return { success: false, error: error instanceof Error ? error.message : "Unknown error" };
      }
    }
  );

  ipcMain.handle(
    "blueprint:cluster",
    async (
      _,
      { workspaceId }: { workspaceId: number }
    ): Promise<{ success: boolean; blueprint?: Blueprint; error?: string }> => {
      try {
        const [app] = await db.select().from(apps).where(eq(apps.id, workspaceId)).limit(1);
        if (!app) return { success: false, error: "Workspace not found" };
        const workspacePath = getAtlarixAppPath(app.path);
        const parsed = await parseProject(workspacePath);
        if (parsed.nodes.length === 0) {
          return { success: false, error: "No nodes to cluster (parse project first or refresh from code)" };
        }
        const { blueprint, pivotBlueprint } = await clusterIntoContainers(
          parsed.nodes,
          parsed.edges,
          { framework: parsed.framework, workspaceId }
        );
        await saveContainersAndBeacons(workspaceId, pivotBlueprint.containers, pivotBlueprint.beacons);
        await saveBlueprintSnapshot(workspaceId, JSON.stringify(blueprint), "ai_cluster");
        await setBlueprintForWorkspace(workspaceId, blueprint);
        return { success: true, blueprint };
      } catch (error) {
        logger.error("blueprint:cluster error:", error);
        return {
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        };
      }
    }
  );
}
