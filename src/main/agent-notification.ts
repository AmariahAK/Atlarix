import log from "electron-log";
import { readSettings } from "./settings";
import { showDesktopNotification } from "./desktop-notification";

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
    const { BrowserWindow } = await import("electron");
    const windows = BrowserWindow.getAllWindows();
    if (windows.length === 0) return;
    if (windows.some((w) => w.isFocused())) return; // focused → skip
    if (readSettings().notificationSound?.enabled === false) return;
    // Lifetime is owned by showDesktopNotification — see the crash it exists for.
    await showDesktopNotification({
      title,
      body,
      onClick: () => {
        const win = BrowserWindow.getAllWindows()[0];
        if (win) {
          if (win.isMinimized()) win.restore();
          win.show();
          win.focus();
        }
      },
    });
  } catch (e) {
    logger.warn("agent OS notification failed:", e);
  }
}
