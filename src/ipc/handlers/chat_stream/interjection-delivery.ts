/**
 * The side effects of delivering a mid-turn user message.
 *
 * `prepareStep` is synchronous and its only job is to shape the model's step
 * input, so the two things that must ALSO happen when an interjection is
 * delivered live here instead:
 *
 *  1. Persist it to the bound workspace session, so it survives a reload like
 *     any other user message (and carries a `sessionRowId`, which is what makes
 *     a row editable — `insertAskUserAnswerUserMessage` learned this the hard
 *     way as the last message kind without one).
 *  2. Insert it into the live turn buffer in front of the streaming placeholder
 *     and emit a `chat:response:chunk`, so it appears the moment the agent
 *     takes it rather than when the turn ends.
 *
 * Fire-and-forget from the caller, and deliberately best-effort: the message is
 * ALREADY on its way to the model by the time this runs, so a failed persist
 * must not be allowed to look like a failed delivery.
 */

import type { IpcMainInvokeEvent } from "electron";
import log from "electron-log";
import { safeSend } from "@/ipc/utils/safe_sender";
import type { UserInterjection } from "@/lib/agent/user-interjections";

const logger = log.scope("user-interjections");

export async function deliverInterjectionsToTranscript(args: {
  chatId: number;
  streamId: number;
  event: IpcMainInvokeEvent;
  placeholderMessageId: number;
  interjections: UserInterjection[];
}): Promise<void> {
  const { chatId, streamId, event, placeholderMessageId, interjections } = args;
  if (!interjections.length) return;
  try {
    const { isStreamTransportId, getStreamTransport, insertUserInterjectionMessage } =
      await import("@/lib/chat/stream-transport");
    if (!isStreamTransportId(chatId)) return;

    for (const item of interjections) {
      let rowId: string | undefined;
      try {
        const {
          resolveOrBindWorkspaceSessionForStream,
          persistWorkspaceSessionUserMessage,
        } = await import("../workspace_session_handlers");
        const sessionId = await resolveOrBindWorkspaceSessionForStream({ chatId });
        const row = await persistWorkspaceSessionUserMessage(sessionId, item.text, {});
        rowId = row?.id;
      } catch (err) {
        // A scratch chat may have no session. The in-memory row still renders.
        logger.warn(`[interjection] could not persist to session: ${String(err)}`);
      }
      insertUserInterjectionMessage(chatId, item.text, placeholderMessageId, rowId);
    }

    const chat = getStreamTransport(chatId);
    // ONE chunk for the batch: each insert mutates the same array, so a chunk
    // per message would just repaint the same growing list N times.
    safeSend(event.sender, "chat:response:chunk", {
      chatId,
      streamId,
      messages: [...(chat?.messages ?? [])],
    });
  } catch (err) {
    logger.warn(`[interjection] transcript insert failed: ${String(err)}`);
  }
}
