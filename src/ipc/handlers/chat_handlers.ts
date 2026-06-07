import { BrowserWindow, ipcMain } from "electron";
import { db } from "../../db";
import { apps } from "../../db/schema";
import { eq } from "drizzle-orm";
import { createLoggedHandler } from "./safe_handle";
import {
  parseDisplaySnapshot,
  type DisplaySnapshotV1,
} from "@/lib/chat/display-snapshot";
import {
  attachmentInfoFromStoredFile,
  hydrateAttachmentStoreFromMessages,
} from "@/lib/attachment-persistence";
import {
  getStreamTransport,
  hydrateStreamTransport,
  isStreamTransportId,
} from "@/lib/chat/stream-transport";
import log from "electron-log";

const logger = log.scope("chat_handlers");
const handle = createLoggedHandler(logger);

const LEGACY_CHAT_REMOVED =
  "Legacy database chats were removed. Open a workspace session from the sidebar.";

export function registerChatHandlers() {
  // v12 0.4-C3: chat:clear-ephemeral-messages deleted — it was a no-op
  // precursor (hydrate replaces the buffer wholesale).

  // v12 2.3: rebuild the background-agent status map from persisted sessions
  // (a "running" row at boot was interrupted by the restart → marked error).
  void import("@/lib/agents/background-agent").then((m) =>
    m.hydrateBackgroundAgentsFromDb(),
  );

  handle(
    "chat:hydrate-ephemeral-messages",
    async (
      _,
      payload: {
        chatId: number;
        messages: {
          role: string;
          content: string;
          id?: number;
          /** v12 0.4-C2: session DB row UUID (direct edit targeting). */
          sessionRowId?: string | null;
          displaySnapshot?: DisplaySnapshotV1 | null;
          modelContent?: string | null;
          pasteAttachments?: import("../ipc_types").PasteAttachmentMeta[] | null;
          fileAttachments?: import("../ipc_types").StoredFileAttachment[] | null;
          attachments?: import("../ipc_types").AttachmentInfo[] | null;
        }[];
      },
    ) => {
      if (!isStreamTransportId(payload.chatId)) return;
      hydrateAttachmentStoreFromMessages(payload.messages ?? []);
      hydrateStreamTransport(payload.chatId, payload.messages ?? []);
    },
  );

  // v12 7A: list a workspace's user-defined agents (.atlarix/agents/*.md)
  // for the mode picker.
  handle("agents:list", async (_, appId: number) => {
    const app = await db.query.apps.findFirst({
      where: eq(apps.id, appId),
      columns: { path: true },
    });
    if (!app?.path) return [];
    const { resolveAppPath } = await import("../../paths/paths");
    const { listUserAgents } = await import("@/lib/agents/user-agents");
    return listUserAgents(resolveAppPath(app.path)).map((a) => ({
      name: a.name,
      description: a.description,
      mode: a.mode,
    }));
  });

  // v12 2.3: spawn a detached background agent for a workspace.
  handle(
    "agents:background:start",
    async (
      _,
      args: {
        appId: number;
        prompt: string;
        title?: string;
        mode?: "ask" | "build";
      },
    ) => {
      const { startBackgroundAgent } = await import(
        "@/lib/agents/background-agent"
      );
      // Fire-and-forget — runs detached; the UI polls agents:background:list.
      const startedAt = Date.now();
      void startBackgroundAgent({ ...args, startedAt }).catch(() => {});
      // S16: nudge the renderer to surface the Agents tab.
      for (const win of BrowserWindow.getAllWindows()) {
        win.webContents.send("agents:background:started", {
          appId: args.appId,
        });
      }
      return { ok: true };
    },
  );

  handle("agents:background:list", async () => {
    const { listBackgroundAgents } = await import(
      "@/lib/agents/background-agent"
    );
    return listBackgroundAgents();
  });

  // v12 2.3 V2: approval gate — keep the writes or revert the turn's snapshot.
  handle(
    "agents:background:resolve",
    async (_, sessionId: string, decision: "keep" | "revert") => {
      const { resolveBackgroundAgent } = await import(
        "@/lib/agents/background-agent"
      );
      return resolveBackgroundAgent(sessionId, decision);
    },
  );

  // v12 2.3: cancel a running background agent (aborts its stream by chatId).
  handle("agents:background:cancel", async (_, sessionId: string) => {
    const { cancelBackgroundAgent } = await import(
      "@/lib/agents/background-agent"
    );
    return cancelBackgroundAgent(sessionId);
  });

  ipcMain.handle("get-chat", async (_, chatId: number) => {
    if (!isStreamTransportId(chatId)) {
      throw new Error(LEGACY_CHAT_REMOVED);
    }

    const ephemeralChat = getStreamTransport(chatId);
    if (!ephemeralChat) {
      throw new Error("Ephemeral chat not found");
    }

    const app = ephemeralChat.appId
      ? await db.query.apps.findFirst({
          where: eq(apps.id, ephemeralChat.appId),
          columns: { path: true, name: true },
        })
      : null;

    hydrateAttachmentStoreFromMessages(ephemeralChat.messages);
    return {
      id: ephemeralChat.id,
      title: ephemeralChat.title,
      messages: ephemeralChat.messages.map((m) => ({
        ...m,
        displaySnapshot: parseDisplaySnapshot(
          (m as { displaySnapshot?: string | DisplaySnapshotV1 | null })
            .displaySnapshot,
        ),
        pasteAttachments:
          (m as { pasteAttachments?: unknown }).pasteAttachments ?? undefined,
        fileAttachments:
          (m as { fileAttachments?: unknown }).fileAttachments ?? undefined,
        attachments:
          (m as { fileAttachments?: Parameters<typeof attachmentInfoFromStoredFile>[0][] })
            .fileAttachments?.map(attachmentInfoFromStoredFile) ?? undefined,
      })),
      createdAt: ephemeralChat.createdAt,
      appId: ephemeralChat.appId ?? null,
      appPath: app?.path ?? null,
    };
  });
}
