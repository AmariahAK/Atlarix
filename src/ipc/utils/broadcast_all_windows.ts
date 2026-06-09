import { BrowserWindow } from "electron";
import { safeSend } from "./safe_sender";

/** Send an IPC payload to every non-destroyed BrowserWindow (main process only). */
export function broadcastToAllWindows(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    // Guard at the *webContents* level, not just the window: during teardown a
    // window can still report `!isDestroyed()` while its webContents is already
    // gone, so `win.webContents.send(...)` throws `Object has been destroyed`.
    // `safeSend` checks `webContents.isDestroyed()/isCrashed()` and try/catches
    // the send; wrap the getter too in case the window tears down mid-loop.
    try {
      if (win.isDestroyed()) continue;
      safeSend(win.webContents, channel, payload);
    } catch {
      /* window/webContents torn down between getAllWindows() and send — skip */
    }
  }
}
