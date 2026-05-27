import { ipcMain } from "electron";
import { openWorkspaceFromCliPath } from "./open_workspace_from_cli";

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
}
