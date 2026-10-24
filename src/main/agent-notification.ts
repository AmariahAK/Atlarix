import log from "electron-log";
import { readSettings } from "./settings";
import { showDesktopNotification } from "./desktop-notification";
import { desktopNotificationsOn } from "@/lib/desktop-notifications";

const logger = log.scope("agent-notification");

/** The session a chat runs in, for a notification that names it and opens it. */
async function sessionOfChat(chatId: number): Promise<{ id: string; title: string } | null> {
  try {
    const { db } = await import("@/db");
    const { chatSessions } = await import("@/db/schema");
    const { eq } = await import("drizzle-orm");
    const s = await db.query.chatSessions.findFirst({ where: eq(chatSessions.streamChatId, chatId) });
    return s ? { id: s.id, title: s.title } : null;
  } catch {
    return null;
  }
}

/**
 * A desktop OS notification when the app is UNFOCUSED and notifications are on
 * (the OS's own sound and Do-Not-Disturb apply). For "Atlarix needs your
 * approval" / "needs your answer" and "finished responding". Focused: nothing,
 * the card or reply is on screen. With `chatId`, the body starts with that
 * session's name (several can be open) and a click opens it. Fire-and-forget.
 */
export async function showAgentNotification(
  title: string,
  body: string,
  opts: { chatId?: number } = {},
): Promise<void> {
  try {
    const { BrowserWindow } = await import("electron");
    const windows = BrowserWindow.getAllWindows();
    if (windows.length === 0) return;
    if (windows.some((w) => w.isFocused())) return; // focused → skip
    if (!desktopNotificationsOn(readSettings())) return;
    const session = opts.chatId != null ? await sessionOfChat(opts.chatId) : null;
    const named = session?.title && session.title !== "Untitled" ? `${session.title}: ${body}` : body;
    // Lifetime is owned by showDesktopNotification — see the crash it exists for.
    await showDesktopNotification({
      title,
      body: named,
      onClick: () => {
        if (session) {
          void import("@/lib/peers/main-host").then((m) => m.openSessionInApp(session.id, { quiet: true }));
          return;
        }
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
