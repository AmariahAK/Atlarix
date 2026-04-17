import { BrowserWindow } from "electron";

/** Send an IPC payload to every non-destroyed BrowserWindow (main process only). */
export function broadcastToAllWindows(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed() && win.webContents) {
      win.webContents.send(channel, payload);
    }
  }
}
