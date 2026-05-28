/**
 * LSP IPC — live diagnostics push to Monaco editors in the renderer.
 */

import { ipcMain } from "electron";
import * as path from "path";
import { eq } from "drizzle-orm";
import log from "electron-log";
import { db } from "@/db";
import { apps } from "@/db/schema";
import { getAtlarixAppPath } from "@/paths/paths";
import {
  notifyFileChange,
  notifyFileClose,
  notifyFileOpen,
  subscribeLspPush,
  unsubscribeLspPush,
} from "@/lib/lsp/lsp-client";

const logger = log.scope("lsp_handlers");

async function resolveWorkspaceRoot(appId: number): Promise<string | null> {
  const app = await db.query.apps.findFirst({
    where: eq(apps.id, appId),
  });
  if (!app?.path) return null;
  return getAtlarixAppPath(app.path);
}

function resolveAbsolutePath(workspaceRoot: string, filePath: string): string {
  return path.isAbsolute(filePath)
    ? path.normalize(filePath)
    : path.normalize(path.join(workspaceRoot, filePath));
}

function assertInsideWorkspace(workspaceRoot: string, absPath: string): void {
  const root = path.resolve(workspaceRoot);
  const target = path.resolve(absPath);
  if (target !== root && !target.startsWith(root + path.sep)) {
    throw new Error("Path escapes workspace root");
  }
}

export function registerLspHandlers(): void {
  ipcMain.handle("lsp:subscribe", async (event, params: { appId: number }) => {
    try {
      const workspaceRoot = await resolveWorkspaceRoot(params.appId);
      if (!workspaceRoot) {
        return { success: false, error: "App not found" };
      }
      subscribeLspPush(event.sender, workspaceRoot);
      event.sender.once("destroyed", () => {
        unsubscribeLspPush(event.sender);
      });
      return { success: true, workspaceRoot };
    } catch (err) {
      logger.error("lsp:subscribe failed", err);
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  });

  ipcMain.handle("lsp:unsubscribe", async (event) => {
    unsubscribeLspPush(event.sender);
    return { success: true };
  });

  ipcMain.handle(
    "lsp:openDocument",
    async (
      _event,
      params: { appId: number; filePath: string; content: string; version?: number },
    ) => {
      try {
        const workspaceRoot = await resolveWorkspaceRoot(params.appId);
        if (!workspaceRoot) {
          return { success: false, error: "App not found" };
        }
        const absPath = resolveAbsolutePath(workspaceRoot, params.filePath);
        assertInsideWorkspace(workspaceRoot, absPath);
        await notifyFileOpen(absPath, workspaceRoot, {
          content: params.content,
          version: params.version,
        });
        return { success: true, filePath: absPath };
      } catch (err) {
        logger.error("lsp:openDocument failed", err);
        return {
          success: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  );

  ipcMain.handle(
    "lsp:change",
    async (
      _event,
      params: { appId: number; filePath: string; content: string; version?: number },
    ) => {
      try {
        const workspaceRoot = await resolveWorkspaceRoot(params.appId);
        if (!workspaceRoot) {
          return { success: false, error: "App not found" };
        }
        const absPath = resolveAbsolutePath(workspaceRoot, params.filePath);
        assertInsideWorkspace(workspaceRoot, absPath);
        await notifyFileChange(absPath, workspaceRoot, {
          content: params.content,
          version: params.version,
        });
        return { success: true, filePath: absPath };
      } catch (err) {
        logger.error("lsp:change failed", err);
        return {
          success: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  );

  ipcMain.handle(
    "lsp:close",
    async (_event, params: { appId: number; filePath: string }) => {
      try {
        const workspaceRoot = await resolveWorkspaceRoot(params.appId);
        if (!workspaceRoot) {
          return { success: false, error: "App not found" };
        }
        const absPath = resolveAbsolutePath(workspaceRoot, params.filePath);
        assertInsideWorkspace(workspaceRoot, absPath);
        await notifyFileClose(absPath, workspaceRoot);
        return { success: true };
      } catch (err) {
        logger.error("lsp:close failed", err);
        return {
          success: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  );

  logger.info("Registered lsp:subscribe, lsp:openDocument, lsp:change, lsp:close");
}
