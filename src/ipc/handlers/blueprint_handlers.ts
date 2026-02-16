/**
 * Blueprint IPC Handlers (Phase 7 Additive Blueprint)
 * ===================================================
 * Blueprints are not persisted (only Live diagrams are saved). In-memory cache per workspace
 * so AI tools and UI share current state; blueprint:updated notifies the renderer.
 */

import { ipcMain, BrowserWindow } from "electron";
import { db } from "@/db";
import { apps } from "@/db/schema";
import { eq } from "drizzle-orm";
import type { Blueprint, CombinedBlueprint } from "@/shared/blueprint-types";
import { createEmptyBlueprint } from "@/shared/blueprint-types";
import { getAtlarixAppPath } from "@/paths/paths";
import { analyzeWorkspaceWithActivity, type ProjectCandidate } from "@/lib/blueprint/project-selector";
import { generateCombinedBlueprint } from "@/lib/blueprint/combined-generator";
import { loadBlueprintCache, saveBlueprintCache, saveUserBlueprint, loadUserBlueprint } from "@/lib/cache/blueprint-cache";
import { generateFromBlueprintDelta, type CodegenDelta, type CodegenResult } from "@/lib/blueprint/codegen";
import { inferBlueprintFromWorkspace } from "@/lib/blueprint/workspace_to_blueprint";
import { rteResultToBlueprint } from "@/lib/blueprint/rte_to_blueprint";
import { generateBlueprint } from "@/lib/blueprint/rte/parsers";
import { getCachedAnalysis } from "@/lib/analysis/workspace-cache";
import { analyzeWorkspace } from "@/lib/analysis/workspace-analyzer";
import { simplifyDescriptionWithAI } from "@/lib/blueprint/descriptions/aiSimplifier";
import log from "electron-log";

const logger = log.scope("blueprint_handlers");

const blueprintCache = new Map<number, Blueprint>();

const INVALID_ROOM_NAMES = new Set([".", "..", ""]);

function sanitizeBlueprint(b: Blueprint): Blueprint {
  const rooms = (b.rooms ?? []).filter(
    (r) => r.label != null && !INVALID_ROOM_NAMES.has(String(r.label).trim())
  );
  const roomIds = new Set(rooms.map((r) => r.id));
  const edges = (b.edges ?? []).filter((e) => roomIds.has(e.from) && roomIds.has(e.to));
  return { rooms, edges, envRefs: b.envRefs ?? [] };
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

async function inferBlueprint(workspaceId: number): Promise<Blueprint> {
  const [app] = await db.select().from(apps).where(eq(apps.id, workspaceId)).limit(1);
  if (!app) return createEmptyBlueprint();
  const workspacePath = getAtlarixAppPath(app.path);
  const cached = await loadBlueprintCache(workspacePath);
  if (cached && cached.nodes.length > 0) {
    const b = rteResultToBlueprint({
      nodes: cached.nodes,
      edges: cached.edges,
      framework: { name: cached.manifest.framework, confidence: 0.8 },
    });
    if (b.rooms.length > 0) return b;
  }
  try {
    const rteResult = await generateBlueprint(workspacePath);
    if (rteResult && rteResult.nodes.length > 0) {
      await saveBlueprintCache(workspacePath, {
        manifest: {
          projectPath: workspacePath,
          framework: rteResult.framework.name,
          language: rteResult.framework.name,
        },
        nodes: rteResult.nodes,
        edges: rteResult.edges,
      });
      return rteResultToBlueprint(rteResult);
    }
  } catch (e) {
    logger.warn("RTE blueprint infer failed, falling back to workspace analysis:", e);
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
  if (cached) return sanitizeBlueprint(cached);
  const [app] = await db.select().from(apps).where(eq(apps.id, workspaceId)).limit(1);
  if (app) {
    const workspacePath = getAtlarixAppPath(app.path);
    const userBlueprint = await loadUserBlueprint(workspacePath);
    if (userBlueprint != null) {
      const sanitized = sanitizeBlueprint(userBlueprint);
      blueprintCache.set(workspaceId, sanitized);
      return sanitized;
    }
  }
  const inferred = await inferBlueprint(workspaceId);
  const sanitized = sanitizeBlueprint(inferred);
  blueprintCache.set(workspaceId, sanitized);
  return sanitized;
}

/** Set blueprint for workspace (in-memory + persist to disk); notifies renderer. Used by AI tools and UI save. */
export async function setBlueprintForWorkspace(workspaceId: number, blueprint: Blueprint): Promise<void> {
  const b = sanitizeBlueprint(blueprint);
  blueprintCache.set(workspaceId, b);
  const [app] = await db.select().from(apps).where(eq(apps.id, workspaceId)).limit(1);
  if (app) {
    try {
      const workspacePath = getAtlarixAppPath(app.path);
      await saveUserBlueprint(workspacePath, b);
    } catch (e) {
      logger.warn("Failed to persist user blueprint:", e);
    }
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

export function registerBlueprintHandlers() {
  ipcMain.handle(
    "blueprint:get",
    async (_, { workspaceId }: { workspaceId: number }): Promise<{ success: boolean; blueprint?: Blueprint; error?: string }> => {
      try {
        const blueprint = await getBlueprintForWorkspace(workspaceId);
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

  // blueprint:codegen - generate scaffold from Blueprint delta (new files + env stub)
  // blueprint:refresh-from-code - Invalidate cache, re-infer from workspace, emit blueprint:updated
  ipcMain.handle(
    "blueprint:refresh-from-code",
    async (_, { workspaceId }: { workspaceId: number }): Promise<{ success: boolean; blueprint?: Blueprint; error?: string }> => {
      try {
        blueprintCache.delete(workspaceId);
        const blueprint = await getBlueprintForWorkspace(workspaceId);
        sendToAllWindows("blueprint:updated", { workspaceId, blueprint });
        return { success: true, blueprint };
      } catch (error) {
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
          const rteResult = await generateBlueprint(selected[0].path);
          if (rteResult && rteResult.nodes.length > 0) {
            blueprintToSet = rteResultToBlueprint(rteResult);
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
}
