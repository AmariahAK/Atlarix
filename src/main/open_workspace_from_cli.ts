/**
 * Open a folder as workspace from CLI / OS file association (atlarix .).
 */

import path from "node:path";
import fs from "node:fs";
import { BrowserWindow } from "electron";
import log from "electron-log";
import { importWorkspaceFromPath } from "../ipc/handlers/import_workspace_core";

const logger = log.scope("open-workspace-cli");

export function parseDirectoryArgFromArgv(
  argv: string[],
  baseCwd: string = process.cwd(),
): string | null {
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg || arg.startsWith("-")) continue;
    if (arg.includes("://")) continue;
    if (arg.endsWith(".asar")) continue;
    try {
      const resolved = path.resolve(baseCwd, arg);
      const stat = fs.statSync(resolved);
      if (stat.isDirectory()) return resolved;
    } catch {
      /* skip invalid paths */
    }
  }
  return null;
}

export async function openWorkspaceFromCliPath(dirPath: string): Promise<void> {
  const resolved = path.resolve(dirPath);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    logger.warn(`[openWorkspaceFromCliPath] Not a directory: ${resolved}`);
    return;
  }

  try {
    const appName = path.basename(resolved) || "Workspace";
    const { appId, chatId } = await importWorkspaceFromPath({
      path: resolved,
      appName,
    });
    logger.log(`[openWorkspaceFromCliPath] Opened ${resolved} appId=${appId} chatId=${chatId}`);

    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send("workspace:opened-from-cli", {
        appId,
        chatId,
        path: resolved,
        name: appName,
      });
    }
  } catch (err) {
    logger.error("[openWorkspaceFromCliPath] failed:", err);
  }
}
