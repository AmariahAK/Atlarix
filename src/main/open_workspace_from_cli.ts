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

export type CliWorkspacePayload = {
  appId: number;
  chatId: number;
  path: string;
  name: string;
};

/**
 * Last CLI workspace open that may not have reached a subscribed renderer.
 * On a COLD start, `openWorkspaceFromCliPath` runs in `onReady()` and pushes the
 * `workspace:opened-from-cli` event before the renderer has mounted its
 * listener — so the event is lost and the welcome screen shows. We buffer the
 * payload here and the renderer pulls it on mount (`workspace:consume-pending-cli`),
 * which closes the race regardless of timing. The live event still covers the
 * already-running (second-instance) case.
 */
let pendingCliWorkspace: CliWorkspacePayload | null = null;

/** Returns and clears the buffered CLI workspace (renderer pulls this on mount). */
export function consumePendingCliWorkspace(): CliWorkspacePayload | null {
  const p = pendingCliWorkspace;
  pendingCliWorkspace = null;
  return p;
}

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

    const payload: CliWorkspacePayload = {
      appId,
      chatId,
      path: resolved,
      name: appName,
    };

    // Buffer for the renderer to pull on mount (closes the cold-start race where
    // the event below is pushed before the renderer subscribes).
    pendingCliWorkspace = payload;

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
