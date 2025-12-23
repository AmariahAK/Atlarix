/**
 * Atlarix Main Handlers
 * ====================
 * IPC handlers for folder selection and app controls
 */

import { ipcMain, dialog, BrowserWindow } from "electron";

/**
 * Register folder dialog handler
 */
export function registerFolderDialogHandler() {
    // Workspace/folder selection
    ipcMain.handle("dialog:openDirectory", async () => {
        const result = await dialog.showOpenDialog({
            properties: ["openDirectory"],
            title: "Select Workspace Folder",
            buttonLabel: "Select Workspace",
        });

        return result;
    });

    // File selection (for attachments)
    ipcMain.handle("dialog:openFiles", async (_, options) => {
        const result = await dialog.showOpenDialog({
            properties: options?.properties || ["openFile", "multiSelections"],
            filters: options?.filters || [{ name: "All Files", extensions: ["*"] }],
            title: "Select Files to Attach",
            buttonLabel: "Select Files",
        });

        return result;
    });
}
