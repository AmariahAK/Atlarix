/**
 * Workflow Handlers
 * =================
 * IPC entrypoints for loading Atlaflow workflows for a workspace.
 */

import { ipcMain } from "electron";
import log from "electron-log";
import { workflowLoader } from "@/lib/workflow/workflow_loader";
import { db } from "@/db";
import { diagrams } from "@/db/schema";
import { desc, eq } from "drizzle-orm";

const logger = log.scope("workflow-handlers");

export function registerWorkflowHandlers() {
  /**
   * Load or infer workflow for a workspace (Atlaflow).
   */
  ipcMain.handle(
    "workflow:load",
    async (
      _,
      params: {
        appId: number;
        workspacePath: string;
      },
    ) => {
      try {
        const result = await workflowLoader.load(params.appId, params.workspacePath);
        return { success: true, ...result };
      } catch (error) {
        logger.error("[workflow:load] Error:", error);
        return {
          success: false,
          workflow: { nodes: [], connections: {} },
          source: "empty",
          isStale: false,
          error: error instanceof Error ? error.message : "Unknown error",
        };
      }
    },
  );

  /**
   * Load per-node messages stored in diagram metadata (if any).
   * For now we simply fetch from the latest diagram for the workspace.
   */
  ipcMain.handle(
    "workflow:load-messages",
    async (_event, params: { appId: number }) => {
      try {
        const latest = await db
          .select()
          .from(diagrams)
          .where(eq(diagrams.workspaceId, params.appId))
          .orderBy(desc(diagrams.updatedAt))
          .limit(1);

        const diagram = latest[0];
        const meta = (diagram?.metadata ?? null) as
          | { nodeMessages?: Array<{ nodeId: string; message: string; createdAt: number; updatedAt: number }> }
          | null;

        return {
          success: true,
          messages: meta?.nodeMessages ?? [],
        };
      } catch (error) {
        logger.error("[workflow:load-messages] Error:", error);
        return {
          success: false,
          messages: [],
          error: error instanceof Error ? error.message : "Unknown error",
        };
      }
    },
  );

  /**
   * Save per-node messages into latest diagram metadata.
   */
  ipcMain.handle(
    "workflow:save-messages",
    async (
      _event,
      params: {
        appId: number;
        messages: Array<{ nodeId: string; message: string; createdAt: number; updatedAt: number }>;
      },
    ) => {
      try {
        const latest = await db
          .select()
          .from(diagrams)
          .where(eq(diagrams.workspaceId, params.appId))
          .orderBy(desc(diagrams.updatedAt))
          .limit(1);

        const diagram = latest[0];
        if (!diagram) {
          return { success: false, error: "No diagram found for workspace" };
        }

        const meta = (diagram.metadata ?? null) as Record<string, unknown> | null;
        const nextMeta: Record<string, unknown> = {
          ...(meta ?? {}),
          nodeMessages: params.messages,
        };

        await db
          .update(diagrams)
          .set({ metadata: nextMeta })
          .where(eq(diagrams.id, diagram.id));

        return { success: true };
      } catch (error) {
        logger.error("[workflow:save-messages] Error:", error);
        return {
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        };
      }
    },
  );
}

