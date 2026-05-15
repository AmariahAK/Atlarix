/**
 * File Handlers
 * =============
 * IPC handlers for direct file read/write operations.
 * Used by the ErrorFileEditor for live code editing.
 *
 * Secret paths: basename-only block + verify filePath is under a registered app path
 * (renderer does not thread workspaceRoot through IPC).
 */

import { ipcMain } from "electron";
import * as fs from "fs/promises";
import * as path from "path";
import { db } from "@/db";
import { apps } from "@/db/schema";
import {
  assertIpcReadableFilePath,
  PATH_ESCAPE_BLOCK_MESSAGE,
} from "@/lib/security/env-secret-paths";

const logger = {
  log: (...args: unknown[]) => console.log("[FileHandlers]", ...args),
  error: (...args: unknown[]) => console.error("[FileHandlers]", ...args),
};

async function assertFileUnderRegisteredWorkspace(filePath: string): Promise<void> {
  assertIpcReadableFilePath(filePath);
  const resolved = path.resolve(filePath);
  const rows = await db.select({ path: apps.path }).from(apps);
  const allowed = rows.some((row) => {
    if (!row.path) return false;
    const root = path.resolve(row.path);
    return resolved === root || resolved.startsWith(root + path.sep);
  });
  if (!allowed) {
    throw new Error(PATH_ESCAPE_BLOCK_MESSAGE);
  }
}

/**
 * Register file-related IPC handlers
 */
export function registerFileHandlers() {
  ipcMain.handle("file:read-content", async (_, params: { filePath: string }) => {
    try {
      await assertFileUnderRegisteredWorkspace(params.filePath);
      const content = await fs.readFile(params.filePath, "utf-8");
      logger.log(`[file:read-content] Read ${params.filePath} (${content.length} bytes)`);
      return { success: true, content };
    } catch (error) {
      logger.error("[file:read-content] Failed:", error);
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  });

  ipcMain.handle(
    "file:write-content",
    async (_, params: { filePath: string; content: string }) => {
      try {
        await assertFileUnderRegisteredWorkspace(params.filePath);
        const dir = path.dirname(params.filePath);
        await fs.mkdir(dir, { recursive: true });

        await fs.writeFile(params.filePath, params.content, "utf-8");
        logger.log(
          `[file:write-content] Wrote ${params.filePath} (${params.content.length} bytes)`,
        );
        return { success: true };
      } catch (error) {
        logger.error("[file:write-content] Failed:", error);
        return {
          success: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
  );

  ipcMain.handle("file:get-stats", async (_, params: { filePath: string }) => {
    try {
      await assertFileUnderRegisteredWorkspace(params.filePath);
      const stats = await fs.stat(params.filePath);
      return {
        success: true,
        exists: true,
        size: stats.size,
        modifiedTime: stats.mtime.getTime(),
        isDirectory: stats.isDirectory(),
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { success: true, exists: false };
      }
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  });

  logger.log("[File Handlers] Registered file:read-content, file:write-content, file:get-stats");
}
