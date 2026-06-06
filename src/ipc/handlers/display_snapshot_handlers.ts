import { eq } from "drizzle-orm";
import { db } from "../../db";
import { sessionMessages } from "../../db/schema";
import { createLoggedHandler } from "./safe_handle";
import log from "electron-log";
import { parseDisplaySnapshot } from "@/lib/chat/display-snapshot";
import {
  isStreamTransportId,
  setTransportMessageDisplaySnapshot,
} from "@/lib/chat/stream-transport";

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
      const parsed = parseDisplaySnapshot(displaySnapshot);
      if (!parsed) {
        throw new Error("Invalid display snapshot payload");
      }
      if (!isStreamTransportId(chatId)) {
        throw new Error("Display snapshots require an active workspace stream");
      }
      const ok = setTransportMessageDisplaySnapshot(
        chatId,
        messageId,
        parsed,
      );
      if (!ok) throw new Error("Ephemeral message not found");
      return { ok: true as const };
    },
  );

  handle(
    "messages:save-display-snapshot",
    async () => {
      throw new Error(
        "Legacy message display snapshots were removed; use session-messages:save-display-snapshot",
      );
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
