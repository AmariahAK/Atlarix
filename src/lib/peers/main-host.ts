/**
 * Main-process wiring for sessions that message each other (peers.ts): which
 * sessions this process runs, and what "deliver" means here.
 *
 * Shared by the desktop app and the CLI — both run these handlers in their main
 * process (the CLI through the Electron stub).
 */
import { eq } from "drizzle-orm";
import log from "electron-log";
import { db, getDb } from "@/db";
import { apps, chatSessions } from "@/db/schema";
import {
  isPlaceholderTitle,
  noteLiveSession,
  noteSessionModel,
  publishPeerState,
  startPeerInbox,
  type Surface,
} from "./peers";
import { isChatStreamLive, onStreamLiveChange } from "@/ipc/handlers/chat_stream/stream-state";
import { recordUserInterjection } from "@/lib/agent/user-interjections";
import { broadcastToAllWindows } from "@/ipc/utils/broadcast_all_windows";
import { readSettings } from "@/main/settings";

const logger = log.scope("peers");

/** Register a session this process has open (on start, open and rename). */
export async function noteSessionOpen(
  sessionId: string,
  chatId: number,
): Promise<void> {
  try {
    const session = await db.query.chatSessions.findFirst({
      where: eq(chatSessions.id, sessionId),
    });
    if (!session) return;
    const app = session.workspaceId
      ? await db.query.apps.findFirst({
          where: eq(apps.id, session.workspaceId),
        })
      : undefined;
    noteLiveSession({
      sessionId,
      chatId,
      name:
        (session.title?.trim() && !isPlaceholderTitle(session.title)
          ? session.title.trim()
          : "") ||
        `New ${process.env.ATLARIX_PEER_SURFACE === "editor" ? "editor " : process.env.ATLARIX_SURFACE === "cli" ? "CLI " : ""}session (${(app?.path ?? "").split(/[\\/]/).pop() || "no folder"})`,
      workspace: app?.path ?? "",
    });
  } catch (e) {
    logger.debug(
      `could not register session ${sessionId}: ${(e as Error).message}`,
    );
  }
}

/**
 * A handoff from the CLI: show `sessionId` in the app and carry on there. The
 * window already showing its workspace if there is one, else the front window;
 * the renderer selects the workspace and opens the session (layout.tsx).
 */
async function openSessionInApp(
  sessionId: string,
): Promise<{ ok: boolean; error?: string }> {
  const session = await db.query.chatSessions.findFirst({
    where: eq(chatSessions.id, sessionId),
  });
  if (!session) return { ok: false, error: "no such session" };
  const app = session.workspaceId
    ? await db.query.apps.findFirst({ where: eq(apps.id, session.workspaceId) })
    : undefined;
  const { getPrimaryWindow, sendToWorkspaceWindow } = await import(
    "@/main/workspace-window-manager"
  );
  const payload = { sessionId, workspaceId: session.workspaceId };
  if (
    app?.path &&
    sendToWorkspaceWindow(app.path, "session:handoff-open", payload)
  ) {
    return { ok: true };
  }
  const win = getPrimaryWindow();
  if (!win) return { ok: false, error: "the app has no window open" };
  const { deliverToWindow } = await import("@/main/create-app-browser-window");
  deliverToWindow(win, "session:handoff-open", payload);
  try {
    const { app: electronApp } = await import("electron");
    electronApp.focus?.({ steal: true });
  } catch {
    /* focusing is a nicety */
  }
  return { ok: true };
}

let unhookLive: (() => void) | null = null;

/**
 * Another session sets this one's mode and/or model (item 9): checked here,
 * the mode stored on the session as a mode picked in it is, and the change
 * told to the windows (the app's, the CLI's and the editors' sessions), which
 * use it from the next turn and show `notice`.
 */
async function applyPeerSettings(
  target: { chatId: number; sessionId: string },
  set: { mode?: string; model?: string },
  from: { name: string },
): Promise<{ ok: boolean; error?: string; notice?: string }> {
  const s = await import("./session-settings");
  let mode: import("./session-settings").PeerMode | undefined;
  if (set.mode) {
    const parsed = s.parseMode(set.mode);
    if (!parsed) return { ok: false, error: `no mode "${set.mode}": build, explore, plan, debug or review` };
    mode = parsed;
  }
  const row = await db.query.chatSessions.findFirst({ where: eq(chatSessions.id, target.sessionId) });
  let model: { provider: string; name: string; label: string } | undefined;
  if (set.model) {
    const { loadModelOptions } = await import("@/cli/agent/models");
    const options = await loadModelOptions().catch(() => []);
    const hit = s.matchModel(set.model, options);
    if ("error" in hit) return { ok: false, error: hit.error };
    // The name list_sessions shows: "label (provider)" when two share a label.
    const shown = s.modelNames(options).find((n) => n.option === hit)?.name ?? hit.label;
    model = { provider: hit.provider, name: hit.name, label: shown };
  }
  if (mode && row) {
    await db.update(chatSessions).set({ workMode: mode }).where(eq(chatSessions.id, target.sessionId));
  }
  if (model) noteSessionModel(target.sessionId, model.label);
  const notice = s.settingsNotice({ mode, model: model?.label }, from.name);
  broadcastToAllWindows("session:peer-settings", {
    chatId: target.chatId,
    sessionId: target.sessionId,
    ...(mode ? { mode } : {}),
    ...(model ? { model } : {}),
    notice,
  });
  return { ok: true, notice };
}

/** Start the inbox for this process. Never throws. */
export async function startPeerMessaging(surface: Surface): Promise<void> {
  try {
    await startPeerInbox({
      surface,
      database: () => {
        try {
          return getDb().$client as never;
        } catch {
          return null;
        }
      },
      host: {
        isBusy: (chatId) => {
          try {
            return isChatStreamLive(chatId);
          } catch {
            return false;
          }
        },
        enqueue: (chatId, id, text) => {
          recordUserInterjection(
            chatId,
            { id: `peer-${id}`, text },
            { cap: null },
          );
        },
        wake: (chatId) => {
          // The same signal a finished background job uses; the app and the CLI
          // answer `peer_message` by opening a turn with what is queued.
          broadcastToAllWindows("chat:background-job-update", {
            chatId,
            source: "peer",
            status: "peer_message",
          });
        },
        // Another surface following this session: the user's own words for the
        // turn (the path a message typed here mid-turn takes), and Stop, which
        // the surface running the chat presses for itself, as its own Stop
        // button would (the app's window, the CLI: `chat:remote-stop`).
        steer: (chatId, id, text) => {
          recordUserInterjection(chatId, { id: `remote-${id}`, text });
        },
        stop: (chatId) => {
          broadcastToAllWindows("chat:remote-stop", { chatId });
        },
        ...(surface === "app" ? { openSession: openSessionInApp } : {}),
        applySettings: applyPeerSettings,
        inbound: () => {
          try {
            const v = (readSettings() as { peerMessages?: string })
              .peerMessages;
            return v === "refuse" ? "refuse" : "accept";
          } catch {
            return "accept";
          }
        },
      },
    });
    // `busy` as a turn starts and ends, not on the next heartbeat: a surface
    // following the session would otherwise see it up to 15 s late.
    unhookLive ??= onStreamLiveChange(() => publishPeerState());
  } catch (e) {
    logger.warn(`messaging between sessions is off: ${(e as Error).message}`);
  }
}
