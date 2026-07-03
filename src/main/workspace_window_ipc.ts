import { ipcMain } from "electron";
import { openWorkspaceFromCliPath } from "./open_workspace_from_cli";
import { createAppBrowserWindow } from "./create-app-browser-window";

export function registerWorkspaceWindowIpc(): void {
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
