import { ipcMain } from "electron";
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
