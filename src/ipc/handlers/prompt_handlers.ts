/**
 * Prompt IPC Handlers - Global + Workspace Prompts
 * =================================================
 * - Global Prompt (1 max): Used in incognito chats
 * - Workspace Prompts (1 per workspace): Used when chatting with workspace
 * 
 * 750 character limit enforced here.
 */

import { IpcMainInvokeEvent } from "electron";
import log from "electron-log";
import { createLoggedHandler } from "./safe_handle";
import { db } from "@/db";
import { prompts, apps } from "@/db/schema";
import { eq, and, isNull } from "drizzle-orm";

const logger = log.scope("prompt_handlers");
const handle = createLoggedHandler(logger);

const MAX_PROMPT_LENGTH = 750;

interface PromptDto {
  id: number;
  type: "global" | "workspace";
  workspaceId: number | null;
  content: string;
  createdAt: Date;
  updatedAt: Date;
}

interface WorkspaceWithStatus {
  id: number;
  name: string;
  path: string;
  hasPrompt: boolean;
  promptContent?: string;
}

function mapToDto(row: any): PromptDto {
  return {
    id: row.id!,
    type: row.type,
    workspaceId: row.workspaceId,
    content: row.content,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function validateLength(content: string): void {
  if (!content || content.trim().length === 0) {
    throw new Error("Prompt content is required");
  }
  if (content.length > MAX_PROMPT_LENGTH) {
    throw new Error(`Prompt exceeds ${MAX_PROMPT_LENGTH} character limit`);
  }
}

export function registerPromptHandlers() {
  // ═══════════════════════════════════════════════════════════
  // GLOBAL PROMPT (1 max for entire system)
  // ═══════════════════════════════════════════════════════════

  /**
   * Get the global prompt (or null if none exists)
   */
  handle("prompts:get-global", async (): Promise<PromptDto | null> => {
    const row = db
      .select()
      .from(prompts)
      .where(and(eq(prompts.type, "global"), isNull(prompts.workspaceId)))
      .limit(1)
      .get();

    return row ? mapToDto(row) : null;
  });

  /**
   * Set/update global prompt (replaces existing if present)
   */
  handle(
    "prompts:set-global",
    async (
      _e: IpcMainInvokeEvent,
      params: { content: string }
    ): Promise<PromptDto> => {
      validateLength(params.content);

      // Delete existing global prompt
      db.delete(prompts)
        .where(and(eq(prompts.type, "global"), isNull(prompts.workspaceId)))
        .run();

      // Insert new global prompt
      const now = new Date();
      const result = db
        .insert(prompts)
        .values({
          type: "global",
          workspaceId: null,
          content: params.content.trim(),
          createdAt: now,
          updatedAt: now,
        })
        .run();

      const id = Number(result.lastInsertRowid);
      const row = db.select().from(prompts).where(eq(prompts.id, id)).get();
      if (!row) throw new Error("Failed to create global prompt");

      logger.log(`Created/updated global prompt (${params.content.length} chars)`);
      return mapToDto(row);
    }
  );

  /**
   * Delete global prompt
   */
  handle("prompts:delete-global", async (): Promise<void> => {
    db.delete(prompts)
      .where(and(eq(prompts.type, "global"), isNull(prompts.workspaceId)))
      .run();
    logger.log("Deleted global prompt");
  });

  // ═══════════════════════════════════════════════════════════
  // WORKSPACE PROMPTS (1 per workspace)
  // ═══════════════════════════════════════════════════════════

  /**
   * Get workspace prompt (or null if none exists)
   */
  handle(
    "prompts:get-workspace",
    async (
      _e: IpcMainInvokeEvent,
      workspaceId: number
    ): Promise<PromptDto | null> => {
      const row = db
        .select()
        .from(prompts)
        .where(
          and(
            eq(prompts.type, "workspace"),
            eq(prompts.workspaceId, workspaceId)
          )
        )
        .limit(1)
        .get();

      return row ? mapToDto(row) : null;
    }
  );

  /**
   * Set/update workspace prompt (replaces existing if present)
   */
  handle(
    "prompts:set-workspace",
    async (
      _e: IpcMainInvokeEvent,
      params: { workspaceId: number; content: string }
    ): Promise<PromptDto> => {
      validateLength(params.content);

      // Verify workspace exists
      const workspace = db
        .select()
        .from(apps)
        .where(eq(apps.id, params.workspaceId))
        .get();
      if (!workspace) {
        throw new Error(`Workspace ${params.workspaceId} not found`);
      }

      // Delete existing workspace prompt
      db.delete(prompts)
        .where(
          and(
            eq(prompts.type, "workspace"),
            eq(prompts.workspaceId, params.workspaceId)
          )
        )
        .run();

      // Insert new workspace prompt
      const now = new Date();
      const result = db
        .insert(prompts)
        .values({
          type: "workspace",
          workspaceId: params.workspaceId,
          content: params.content.trim(),
          createdAt: now,
          updatedAt: now,
        })
        .run();

      const id = Number(result.lastInsertRowid);
      const row = db.select().from(prompts).where(eq(prompts.id, id)).get();
      if (!row) throw new Error("Failed to create workspace prompt");

      logger.log(
        `Created/updated prompt for workspace ${workspace.name} (${params.content.length} chars)`
      );
      return mapToDto(row);
    }
  );

  /**
   * Delete workspace prompt
   */
  handle(
    "prompts:delete-workspace",
    async (_e: IpcMainInvokeEvent, workspaceId: number): Promise<void> => {
      db.delete(prompts)
        .where(
          and(
            eq(prompts.type, "workspace"),
            eq(prompts.workspaceId, workspaceId)
          )
        )
        .run();
      logger.log(`Deleted prompt for workspace ${workspaceId}`);
    }
  );

  // ═══════════════════════════════════════════════════════════
  // UTILITY
  // ═══════════════════════════════════════════════════════════

  /**
   * Delete any prompt by ID
   */
  handle(
    "prompts:delete",
    async (_e: IpcMainInvokeEvent, id: number): Promise<void> => {
      if (!id) throw new Error("Prompt id is required");
      db.delete(prompts).where(eq(prompts.id, id)).run();
      logger.log(`Deleted prompt ${id}`);
    }
  );

  /**
   * List all workspaces with their prompt status
   * Used by Library page to show which workspaces have prompts
   */
  handle(
    "prompts:list-workspaces-with-status",
    async (): Promise<WorkspaceWithStatus[]> => {
      const allApps = db.select().from(apps).all();
      logger.log(`[prompts:list-workspaces-with-status] Found ${allApps.length} workspaces`);

      const workspacePrompts = db
        .select()
        .from(prompts)
        .where(eq(prompts.type, "workspace"))
        .all();

      // Map workspaceId to prompt content
      const promptMap = new Map<number, string>();
      for (const p of workspacePrompts) {
        if (p.workspaceId) {
          promptMap.set(p.workspaceId, p.content);
        }
      }

      const result = allApps.map((app) => ({
        id: app.id!,
        name: app.name,
        path: app.path,
        hasPrompt: promptMap.has(app.id!),
        promptContent: promptMap.get(app.id!),
      }));

      logger.log(`[prompts:list-workspaces-with-status] Returning:`, result.map(r => r.name));
      return result;
    }
  );

  // ═══════════════════════════════════════════════════════════
  // LEGACY ENDPOINTS (kept for backwards compatibility)
  // ═══════════════════════════════════════════════════════════

  // These are no longer used but kept to prevent errors
  handle("prompts:list", async (): Promise<PromptDto[]> => {
    logger.warn("prompts:list is deprecated, use prompts:get-global or prompts:get-workspace");
    return [];
  });

  handle(
    "prompts:create",
    async (_e: IpcMainInvokeEvent, params: any): Promise<PromptDto> => {
      logger.warn("prompts:create is deprecated, use prompts:set-global or prompts:set-workspace");
      throw new Error("Use prompts:set-global or prompts:set-workspace instead");
    }
  );

  handle(
    "prompts:update",
    async (_e: IpcMainInvokeEvent, params: any): Promise<void> => {
      logger.warn("prompts:update is deprecated, use prompts:set-global or prompts:set-workspace");
      throw new Error("Use prompts:set-global or prompts:set-workspace instead");
    }
  );
}
