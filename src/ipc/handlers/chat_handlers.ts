import { ipcMain } from "electron";
import { db } from "../../db";
import { apps } from "../../db/schema";
import { eq } from "drizzle-orm";
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
  isStreamTransportId,
} from "@/lib/chat/stream-transport";

const LEGACY_CHAT_REMOVED =
  "Legacy database chats were removed. Open a workspace session from the sidebar.";

export function registerChatHandlers() {
  // v12 0.4-C3: chat:clear-ephemeral-messages deleted — it was a no-op
  // precursor (hydrate replaces the buffer wholesale).
  //
  // `chat:hydrate-ephemeral-messages` deleted with the session-load round trip: the
  // renderer used it to send content + modelContent + displaySnapshot BACK to main
  // for bytes main had just read out of SQLite. `sessions:hydrate-transport`
  // (workspace_session_handlers.ts) takes the renderer's numeric ids — the one thing
  // main cannot know — and joins the bodies from its own rows.

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
          (
            m as {
              fileAttachments?: Parameters<
                typeof attachmentInfoFromStoredFile
              >[0][];
            }
          ).fileAttachments?.map(attachmentInfoFromStoredFile) ?? undefined,
      })),
      createdAt: ephemeralChat.createdAt,
      appId: ephemeralChat.appId ?? null,
      appPath: app?.path ?? null,
    };
  });
}
