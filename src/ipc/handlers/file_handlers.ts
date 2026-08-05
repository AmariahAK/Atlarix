/**
 * File Handlers
 * =============
 * IPC handlers for direct file read/write operations.
 *
 * Secret paths: basename-only block + verify filePath is under a registered app path
 * (renderer does not thread workspaceRoot through IPC).
 */

import { ipcMain } from "electron";
import * as fs from "fs/promises";
import * as path from "node:path";
import { eq } from "drizzle-orm";
import { assertFileUnderRegisteredWorkspace } from "@/lib/security/workspace-path";
import { db } from "../../db";
import { apps } from "../../db/schema";
import { getAtlarixAppPath } from "../../paths/paths";
import { searchWorkspaceFiles } from "../utils/workspace-file-list";

/**
 * Cap on entries SHIPPED to the @-mention autocomplete for one query.
 *
 * Note what this is not: the old `MENTION_PATHS_LIMIT = 4000` capped the CORPUS
 * — the list was built once, truncated, and then searched — so on any repo past
 * 4,000 files the tail was unmentionable no matter what you typed (5,505 files
 * here, so ~1,500 of them). This caps the RESULT of a search over every file, and
 * the menu renders at most 8 of them.
 */
const MENTION_RESULT_LIMIT = 500;

/** Derive the set of folder paths implied by a list of relative file paths. */
function deriveDirs(files: string[]): string[] {
  const dirs = new Set<string>();
  for (const f of files) {
    const parts = f.split("/");
    parts.pop(); // drop filename
    let acc = "";
    for (const seg of parts) {
      acc = acc ? `${acc}/${seg}` : seg;
      dirs.add(acc);
    }
  }
  return [...dirs].sort();
}

const logger = {
  log: (...args: unknown[]) => console.log("[FileHandlers]", ...args),
  error: (...args: unknown[]) => console.error("[FileHandlers]", ...args),
};

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

  // Powers the chat composer `@` autocomplete: files + folders in the current
  // workspace, gitignore-aware via bundled ripgrep. A LIVE query per keystroke
  // (~15-20 ms) rather than a pre-built, 5-minute-cached, truncated list — so the
  // results are fresh, complete, and only the matches cross IPC.
  //
  // Folders are derived from the MATCHING files, which is equivalent to deriving
  // them from every file and then filtering: a folder path can only contain the
  // query if every file beneath it does too.
  ipcMain.handle(
    "workspace:list-paths",
    async (_, params: { appId: number; query?: string }) => {
      try {
        const app = await db.query.apps.findFirst({
          where: eq(apps.id, params.appId),
        });
        if (!app) return { files: [], dirs: [] };
        const appPath = getAtlarixAppPath(app.path);
        const matched = await searchWorkspaceFiles(appPath, params.query ?? "");
        return {
          files: matched.slice(0, MENTION_RESULT_LIMIT),
          dirs: deriveDirs(matched).slice(0, MENTION_RESULT_LIMIT),
        };
      } catch (error) {
        logger.error("[workspace:list-paths] Failed:", error);
        return { files: [], dirs: [] };
      }
    },
  );

  logger.log("[File Handlers] Registered file:read-content, file:write-content, file:get-stats, workspace:list-paths");
}
