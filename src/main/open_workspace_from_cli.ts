/**
 * Open a folder as workspace from CLI / OS file association (`atlarix .` / `atlarix /path`).
 * Uses importWorkspaceFromPath: opens existing app by path, or registers a new workspace + chat.
 */

import path from "node:path";
import fs from "node:fs";
import log from "electron-log";
import { importWorkspaceFromPath } from "../ipc/handlers/import_workspace_core";
import { createAppBrowserWindow, deliverToWindow } from "./create-app-browser-window";
import {
  focusOrOpenWorkspaceWindow,
  getPrimaryWindow,
  sendToWorkspaceWindow,
} from "./workspace-window-manager";

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

export async function openWorkspaceFromCliPath(
  dirPath: string,
  options?: { forceNewWindow?: boolean },
): Promise<void> {
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

    const payload = {
      appId,
      chatId,
      path: resolved,
      name: appName,
    };

    if (options?.forceNewWindow) {
      const win = focusOrOpenWorkspaceWindow(resolved, () => createAppBrowserWindow());
      deliverToWindow(win, "workspace:opened-from-cli", payload);
      return;
    }

    const sent = sendToWorkspaceWindow(
      resolved,
      "workspace:opened-from-cli",
      payload,
    );
    if (!sent) {
      const win = getPrimaryWindow();
      if (win) {
        deliverToWindow(win, "workspace:opened-from-cli", payload);
      }
    }
  } catch (err) {
    logger.error("[openWorkspaceFromCliPath] failed:", err);
  }
}
