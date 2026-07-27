import { BrowserWindow, ipcMain } from "electron";
import { openWorkspaceFromCliPath } from "./open_workspace_from_cli";
import { createAppBrowserWindow } from "./create-app-browser-window";
import {
  registerWindowForWorkspace,
  setWorkspaceWindowTitle,
} from "./workspace-window-manager";

export function registerWorkspaceWindowIpc(): void {
  /**
   * The renderer telling main which workspace this window is showing.
   *
   * Main could not previously know. Only `openWorkspaceFromCliPath` registered a
   * window, so a window opened from the UI — including the primary one, and every
   * `window:open-blank` where the user then picks a folder — was bound to nothing.
   * That left the workspace→window registry effectively empty, which is why
   * per-window routing had to fall back to broadcasting to ALL windows and state
   * from one project surfaced in another.
   *
   * Idempotent: re-binding the same window to the same workspace is the normal
   * case (renderer reloads, workspace re-selected).
   */
  ipcMain.handle("workspace:bind-window", (event, folderPath: unknown) => {
    if (typeof folderPath !== "string" || !folderPath.trim()) {
      return { ok: false as const };
    }
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win.isDestroyed()) return { ok: false as const };
    registerWindowForWorkspace(folderPath, win);
    setWorkspaceWindowTitle(win, folderPath);
    return { ok: true as const };
  });

  ipcMain.handle(
    "workspace:open-in-new-window",
    async (_event, folderPath: unknown) => {
      if (typeof folderPath !== "string" || !folderPath.trim()) {
        throw new Error("workspace path is required");
      }
      await openWorkspaceFromCliPath(folderPath, { forceNewWindow: true });
      return { ok: true as const };
    },
  );
  // v14.8.10: fresh window with NO workspace bound — lands on the home/chooser
  // so the user picks a workspace (the sidebar button's expected behavior).
  ipcMain.handle("window:open-blank", async () => {
    createAppBrowserWindow();
    return { ok: true as const };
  });
}
