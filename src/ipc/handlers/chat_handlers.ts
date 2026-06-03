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
  clearEphemeralChatMessages,
  getEphemeralChat,
  hydrateEphemeralChatMessages,
  isEphemeralChatId,
} from "@/lib/ephemeral-chat";
import log from "electron-log";

const logger = log.scope("chat_handlers");
const handle = createLoggedHandler(logger);

const LEGACY_CHAT_REMOVED =
  "Legacy database chats were removed. Open a workspace session from the sidebar.";

export function registerChatHandlers() {
  handle("chat:clear-ephemeral-messages", async (_, chatId: number) => {
    if (!isEphemeralChatId(chatId)) return;
    clearEphemeralChatMessages(chatId);
  });

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
          displaySnapshot?: DisplaySnapshotV1 | null;
          modelContent?: string | null;
          pasteAttachments?: import("../ipc_types").PasteAttachmentMeta[] | null;
          fileAttachments?: import("../ipc_types").StoredFileAttachment[] | null;
          attachments?: import("../ipc_types").AttachmentInfo[] | null;
        }[];
      },
    ) => {
      if (!isEphemeralChatId(payload.chatId)) return;
      hydrateAttachmentStoreFromMessages(payload.messages ?? []);
      hydrateEphemeralChatMessages(payload.chatId, payload.messages ?? []);
    },
  );

  ipcMain.handle("get-chat", async (_, chatId: number) => {
    if (!isEphemeralChatId(chatId)) {
      throw new Error(LEGACY_CHAT_REMOVED);
    }

    const ephemeralChat = getEphemeralChat(chatId);
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
