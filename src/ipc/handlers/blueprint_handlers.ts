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
import type { Blueprint } from "@/shared/blueprint-types";
import { createEmptyBlueprint } from "@/shared/blueprint-types";
import { getAtlarixAppPath } from "@/paths/paths";
import { generateFromBlueprintDelta, type CodegenDelta, type CodegenResult } from "@/lib/blueprint/codegen";
import { inferBlueprintFromWorkspace } from "@/lib/blueprint/workspace_to_blueprint";
import { getCachedAnalysis } from "@/lib/analysis/workspace-cache";
import { analyzeWorkspace } from "@/lib/analysis/workspace-analyzer";
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

/** Get blueprint for workspace (cache or infer). Used by IPC and AI tools. */
export async function getBlueprintForWorkspace(workspaceId: number): Promise<Blueprint> {
  const cached = blueprintCache.get(workspaceId);
  if (cached) return sanitizeBlueprint(cached);
  const inferred = await inferBlueprint(workspaceId);
  const sanitized = sanitizeBlueprint(inferred);
  blueprintCache.set(workspaceId, sanitized);
  return sanitized;
}

/** Set blueprint for workspace (in-memory only; notifies renderer). Used by AI tools and optional UI. */
export async function setBlueprintForWorkspace(workspaceId: number, blueprint: Blueprint): Promise<void> {
  const b = sanitizeBlueprint(blueprint);
  blueprintCache.set(workspaceId, b);
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
}
