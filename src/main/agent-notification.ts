import log from "electron-log";
import { readSettings } from "./settings";

const logger = log.scope("agent-notification");

/**
 * Show a desktop OS notification when the app is UNFOCUSED and the notification
 * setting is on (the OS honors Do-Not-Disturb). Used for BOTH "Atlarix needs
 * you" (a permission / ask_user wait) and "Atlarix finished responding" — the
 * same UI for both, as requested. No-op when the window is focused (the in-app
 * chime/toast covers that) so we never spam a user who's watching. Fire-and-forget.
 */
export async function showAgentNotification(title: string, body: string): Promise<void> {
  try {
    const { BrowserWindow, Notification } = await import("electron");
    const windows = BrowserWindow.getAllWindows();
    if (windows.length === 0) return;
    if (windows.some((w) => w.isFocused())) return; // focused → skip
    if (readSettings().notificationSound?.enabled === false) return;
    if (!Notification.isSupported()) return;
    const n = new Notification({
      title,
      body: String(body).slice(0, 140),
      silent: false,
    });
    n.on("click", () => {
      const win = BrowserWindow.getAllWindows()[0];
      if (win) {
        if (win.isMinimized()) win.restore();
        win.show();
        win.focus();
      }
    });
    n.show();
  } catch (e) {
    logger.warn("agent OS notification failed:", e);
  }
}
