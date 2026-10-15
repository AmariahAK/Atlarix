/**
 * Saving a turn the user stopped (or the loop guard stopped), for Build and
 * Ask alike: the partial reply goes onto the turn's message in the chat and
 * onto its interrupted row on disk, with a note telling the model it was
 * stopped and the steps that finished before it. The renderer does not save a
 * stopped reply; this row is the record (app QA #1, 2026-10-14: without the
 * note, a chat reopened from disk read the stopped request as still open).
 */
import log from "electron-log";
import type { ModelMessage } from "ai";
import { LOOP_REPETITION_STREAM_STOP } from "@/lib/stream/stream-stop-sentinels";
import { stripThinkBlocks } from "@/ipc/utils/thinking_tags";
import { serializeNativeHistory, stoppedTurnNative } from "@/lib/ai/native-history";
import {
  liveRoundStepsByChatId,
  partialResponses,
  streamTurnIdByChatId,
} from "@/ipc/handlers/chat_stream/stream-state";
import {
  flushInterruptedDraft,
  keepInterruptedDraft,
} from "@/ipc/handlers/chat_stream/stream-lifecycle";

const logger = log.scope("chat_stream_handlers");

export async function saveStoppedTurn(args: {
  req: { chatId: number; workspaceSessionId?: string | null };
  stopSentinel: string | undefined;
  nativeTurnMessages: ModelMessage[];
  builtinProviderId?: string;
}): Promise<void> {
  const { req, stopSentinel, nativeTurnMessages, builtinProviderId } = args;
  const chatId = req.chatId;
  // Nothing streamed yet still records the turn as stopped: with no row, a
  // reopened chat read the request as still open (QA 15.7.1 #2).
  const partialResponse = partialResponses.get(req.chatId) ?? "";
  {
    try {
      const stopNote =
        stopSentinel === LOOP_REPETITION_STREAM_STOP
          ? "[Repeated action — task stopped. Review the activity log and send a message to continue.]"
          : "[Response cancelled by user]";
      const cancelledContent = partialResponse ? `${partialResponse}

${stopNote}` : stopNote;
      const { appendTransportMessage, getStreamTransport } = await import(
        "@/lib/chat/stream-transport"
      );
      // What finished before the stop reaches the next turn as real tool
      // calls and results, as Claude Code and codex keep them.
      const live = liveRoundStepsByChatId.get(req.chatId);
      liveRoundStepsByChatId.delete(req.chatId);
      const native = stoppedTurnNative(
        nativeTurnMessages,
        live && live.turn === streamTurnIdByChatId.get(req.chatId)
          ? live.steps()
          : [],
        `${stopNote} The steps above finished before the stop; anything after them did not run.`,
      );
      // Always set, so the saved row tells the model the turn was stopped
      // even when no tool step finished. The row's text has no note, and a
      // chat reopened from disk read a stopped request as still open: the
      // next message (a peer's) re-ran it (app QA #1, 2026-10-14).
      const modelContent =
        serializeNativeHistory(
          native ?? [
            { role: "assistant", content: stripThinkBlocks(cancelledContent) },
          ],
          { builtinProviderId: builtinProviderId },
        ) || undefined;
      // Onto the turn's own message, not a second one beside it: the copy
      // showed the stopped turn twice, once with and once without its
      // thinking (QA #34).
      const pid = Number(streamTurnIdByChatId.get(req.chatId));
      const own = Number.isFinite(pid)
        ? getStreamTransport(req.chatId)?.messages.find(
            (m) => m.id === pid && m.role === "assistant",
          )
        : undefined;
      if (own) {
        own.content = stripThinkBlocks(cancelledContent);
        if (modelContent) own.modelContent = modelContent;
      } else {
        appendTransportMessage(req.chatId, {
          role: "assistant",
          content: stripThinkBlocks(cancelledContent),
          ...(modelContent ? { modelContent } : {}),
        });
      }
      // Issue 4: persist the partial to the session DB as an
      // interrupted row so it survives reload and offers Continue.
      if (req.workspaceSessionId) {
        await flushInterruptedDraft(
          req.chatId,
          req.workspaceSessionId,
          partialResponse || stopNote,
          { force: true, ...(modelContent ? { modelContent } : {}) },
        );
        // That row is now this turn's record: the next turn must not reuse it.
        keepInterruptedDraft(req.chatId);
      }
      logger.log(
        `Persisted partial response to ephemeral chat ${chatId} after abort`,
      );
      partialResponses.delete(req.chatId);
    } catch (error) {
      logger.error(
        `Error saving partial response for chat ${chatId}:`,
        error,
      );
    }
  }
}
