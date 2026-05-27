import { eq } from "drizzle-orm";
import { db } from "../../db";
import { messages, sessionMessages } from "../../db/schema";
import { createLoggedHandler } from "./safe_handle";
import log from "electron-log";
import { parseDisplaySnapshot } from "@/lib/chat/display-snapshot";
import {
  isEphemeralChatId,
  setEphemeralMessageDisplaySnapshot,
} from "@/lib/ephemeral-chat";

const logger = log.scope("display_snapshot_handlers");
const handle = createLoggedHandler(logger);

export function registerDisplaySnapshotHandlers(): void {
  handle(
    "chat:set-display-snapshot",
    async (
      _event,
      payload: {
        chatId: number;
        messageId: number;
        displaySnapshot: string;
      },
    ) => {
      const { chatId, messageId, displaySnapshot } = payload;
      if (!parseDisplaySnapshot(displaySnapshot)) {
        throw new Error("Invalid display snapshot payload");
      }
      if (isEphemeralChatId(chatId)) {
        const ok = setEphemeralMessageDisplaySnapshot(
          chatId,
          messageId,
          parseDisplaySnapshot(displaySnapshot)!,
        );
        if (!ok) throw new Error("Ephemeral message not found");
        return { ok: true as const };
      }
      if (!Number.isFinite(messageId) || messageId <= 0) {
        throw new Error("Invalid message id for display snapshot");
      }
      await db
        .update(messages)
        .set({ displaySnapshot })
        .where(eq(messages.id, messageId));
      return { ok: true as const };
    },
  );

  handle(
    "messages:save-display-snapshot",
    async (
      _event,
      payload: { messageId: number; displaySnapshot: string },
    ) => {
      const { messageId, displaySnapshot } = payload;
      if (!Number.isFinite(messageId) || messageId <= 0) {
        throw new Error("Invalid message id for display snapshot");
      }
      if (!parseDisplaySnapshot(displaySnapshot)) {
        throw new Error("Invalid display snapshot payload");
      }
      await db
        .update(messages)
        .set({ displaySnapshot })
        .where(eq(messages.id, messageId));
      return { ok: true as const };
    },
  );

  handle(
    "session-messages:save-display-snapshot",
    async (
      _event,
      payload: { sessionMessageId: string; displaySnapshot: string },
    ) => {
      const { sessionMessageId, displaySnapshot } = payload;
      if (!sessionMessageId?.trim()) {
        throw new Error("sessionMessageId required");
      }
      if (!parseDisplaySnapshot(displaySnapshot)) {
        throw new Error("Invalid display snapshot payload");
      }
      await db
        .update(sessionMessages)
        .set({ displaySnapshot })
        .where(eq(sessionMessages.id, sessionMessageId));
      return { ok: true as const };
    },
  );
}
