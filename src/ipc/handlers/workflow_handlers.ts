/**
 * Workflow Handlers
 * =================
 * IPC entrypoints for loading Atlaflow workflows and generating code from workflow.
 */

import { ipcMain } from "electron";
import log from "electron-log";
import { workflowLoader } from "@/lib/workflow/workflow_loader";
import { atlaflowToAppMap } from "@/lib/workflow/atlaflow_to_app_map";
import { detectRuntime } from "@/lib/workflow/extractors";
import { applyAppMap } from "@/lib/workflow/codegen";
import type { AppMap } from "@/lib/workflow/app_map_types";
import { db } from "@/db";
import { diagrams, workflowTemplates } from "@/db/schema";
import { desc, eq } from "drizzle-orm";
import type { AtlaflowWorkflow } from "@/lib/workflow/atlaflow_converter";

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
   * Load workflow splits for polyproject (two workflows on one screen).
   */
  ipcMain.handle(
    "workflow:load-splits",
    async (
      _,
      params: { appId: number; workspacePath: string },
    ) => {
      try {
        const { splits } = await workflowLoader.loadSplits(params.appId, params.workspacePath);
        return { success: true, splits };
      } catch (error) {
        logger.error("[workflow:load-splits] Error:", error);
        return { success: false, splits: [], error: error instanceof Error ? error.message : "Unknown error" };
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

  /**
   * Generate code from Atlaflow workflow (Apply / Generate Code).
   * Converts workflow → AppMap → codegen → project files; updates diagram metadata (workflow + appMap) for delta.
   */
  ipcMain.handle(
    "workflow:generate-code",
    async (
      _,
      params: {
        workspacePath: string;
        workflow: AtlaflowWorkflow;
        appId?: number;
      },
    ) => {
      try {
        const runtime = await detectRuntime(params.workspacePath);
        const effectiveRuntime = runtime ?? "node";
        const appMap = atlaflowToAppMap(params.workflow, effectiveRuntime);
        let lastAppMap: AppMap | null = null;
        if (params.appId) {
          const [latest] = await db
            .select()
            .from(diagrams)
            .where(eq(diagrams.workspaceId, params.appId))
            .orderBy(desc(diagrams.updatedAt))
            .limit(1);
          const meta = (latest?.metadata ?? null) as { appMap?: AppMap } | null;
          lastAppMap = meta?.appMap ?? null;
        }
        const result = await applyAppMap(params.workspacePath, appMap);
        const diff =
          lastAppMap && result.success
            ? {
                addedEntryPoints: appMap.entryPoints.filter((ep) => !lastAppMap!.entryPoints.some((e) => e.id === ep.id)).length,
                removedEntryPoints: lastAppMap.entryPoints.filter((e) => !appMap.entryPoints.some((ep) => ep.id === e.id)).length,
                addedDataSources: appMap.dataSources.filter((ds) => !lastAppMap!.dataSources.some((d) => d.id === ds.id)).length,
              }
            : undefined;
        if (result.success && params.appId) {
          const [latest] = await db
            .select()
            .from(diagrams)
            .where(eq(diagrams.workspaceId, params.appId))
            .orderBy(desc(diagrams.updatedAt))
            .limit(1);
          if (latest) {
            const meta = (latest.metadata ?? null) as Record<string, unknown> | null;
            await db
              .update(diagrams)
              .set({
                metadata: {
                  ...(meta ?? {}),
                  workflow: params.workflow,
                  appMap,
                  workflowVersion: Date.now(),
                },
              })
              .where(eq(diagrams.id, latest.id));
          }
        }
        return { success: result.success, ...result, diff };
      } catch (error) {
        logger.error("[workflow:generate-code] Error:", error);
        return {
          success: false,
          filesCreated: [],
          filesUpdated: [],
          message: error instanceof Error ? error.message : "Unknown error",
          error: error instanceof Error ? error.message : "Unknown error",
        };
      }
    },
  );

  // --- Template library (save/load workflow templates) ---

  ipcMain.handle(
    "workflow:template-save",
    async (
      _,
      params: {
        name: string;
        description?: string;
        workflow: AtlaflowWorkflow;
      },
    ) => {
      try {
        const [row] = await db
          .insert(workflowTemplates)
          .values({
            name: params.name,
            description: params.description ?? null,
            workflow: params.workflow as { nodes: unknown[]; connections: unknown },
          })
          .returning({ id: workflowTemplates.id });
        return { success: true, id: row?.id ?? null };
      } catch (error) {
        logger.error("[workflow:template-save] Error:", error);
        return {
          success: false,
          id: null,
          error: error instanceof Error ? error.message : "Unknown error",
        };
      }
    },
  );

  ipcMain.handle("workflow:template-list", async () => {
    try {
      const rows = await db
        .select({
          id: workflowTemplates.id,
          name: workflowTemplates.name,
          description: workflowTemplates.description,
          createdAt: workflowTemplates.createdAt,
        })
        .from(workflowTemplates)
        .orderBy(desc(workflowTemplates.updatedAt));
      return { success: true, templates: rows };
    } catch (error) {
      logger.error("[workflow:template-list] Error:", error);
      return {
        success: false,
        templates: [],
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  });

  ipcMain.handle(
    "workflow:template-get",
    async (_, params: { id: number }) => {
      try {
        const [row] = await db
          .select()
          .from(workflowTemplates)
          .where(eq(workflowTemplates.id, params.id))
          .limit(1);
        if (!row) {
          return { success: false, workflow: null, error: "Template not found" };
        }
        return {
          success: true,
          workflow: row.workflow as AtlaflowWorkflow,
          name: row.name,
          description: row.description,
        };
      } catch (error) {
        logger.error("[workflow:template-get] Error:", error);
        return {
          success: false,
          workflow: null,
          error: error instanceof Error ? error.message : "Unknown error",
        };
      }
    },
  );

  ipcMain.handle(
    "workflow:template-delete",
    async (_, params: { id: number }) => {
      try {
        await db
          .delete(workflowTemplates)
          .where(eq(workflowTemplates.id, params.id));
        return { success: true };
      } catch (error) {
        logger.error("[workflow:template-delete] Error:", error);
        return {
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        };
      }
    },
  );
}

