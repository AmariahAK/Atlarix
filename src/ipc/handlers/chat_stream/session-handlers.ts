/**
 * Small session/mode IPC handlers extracted from registerChatStreamHandlers:
 * respond-mode-change, chat:submit-user-question-answer, and the mid-turn
 * user-message ("interjection") queue.
 * Independent of the streaming turn engine — registered by the parent.
 *
 * (Satellite: never imports the parent handler.)
 */

import { ipcMain } from "electron";
import log from "electron-log";
import type { WorkMode } from "@/lib/schemas";
import { writeSettings } from "@/main/settings";
import { settingsPatchForWorkMode } from "@/lib/work-mode";
import { safeSend } from "@/ipc/utils/safe_sender";
import { resolveModeChange } from "./stream-lifecycle";
import { pendingAskUserArtifactByChatId } from "./stream-state";
import {
  recordUserInterjection,
  cancelUserInterjection,
  listPendingUserInterjections,
  takeUserInterjectionsAsPrompt,
  setUserInterjectionNotifier,
} from "@/lib/agent/user-interjections";
import { broadcastToAllWindows } from "@/ipc/utils/broadcast_all_windows";

const logger = log.scope("chat_stream_handlers");

export function registerSessionHandlers(): void {
  ipcMain.handle(
    "respond-mode-change",
    async (
      _event,
      payload: { chatId: number; approve: boolean; requestedMode?: string },
    ): Promise<{ ok: boolean }> => {
      const { chatId, approve, requestedMode } = payload;
      resolveModeChange(chatId, approve);
      if (approve) {
        const mode = (requestedMode ?? "build") as WorkMode;
        writeSettings(settingsPatchForWorkMode(mode));
      }
      return { ok: true };
    },
  );

  // v11.1 end-turn ask_user: the asking turn already ENDED. Submitting answers
  // (1) records the readable Q→A transcript as a REAL user message (ephemeral
  // store + bound workspace session so it survives reloads), then (2) tells
  // the renderer to start a continuation stream (`continueAfterQuestions`) —
  // the model sees its question turn + the answers and continues the task.
  ipcMain.handle(
    "chat:submit-user-question-answer",
    async (
      event,
      payload: {
        chatId: number;
        questionId: string;
        answer: string;
        questionText: string;
      },
    ): Promise<{ success: boolean; restream?: boolean }> => {
      const { formatInteractiveQaLine } = await import(
        "@/lib/interactive-qa-format"
      );
      const {
        isStreamTransportId,
        getStreamTransport,
        insertAskUserAnswerUserMessage,
      } = await import("@/lib/chat/stream-transport");

      pendingAskUserArtifactByChatId.delete(payload.chatId);
      const content = formatInteractiveQaLine(
        payload.questionText,
        payload.answer,
      );

      if (!isStreamTransportId(payload.chatId)) {
        // Workspace chats are the only ask_user surface (ephemeral transport
        // + session log). A non-ephemeral id here means stale UI state.
        logger.warn(
          `[ask_user] Answer submitted for non-ephemeral chat ${payload.chatId} — ignored`,
        );
        return { success: false };
      }

      // Durable copy in the bound workspace session FIRST (best-effort: a
      // session may not exist for scratch chats — the in-memory message
      // still works). v12 0.4-C3: persist-then-insert so the in-memory
      // message carries its row UUID (sessionRowId) — the last message kind
      // that lacked it, which kept the ordinal edit fallback alive.
      let qaRowId: string | undefined;
      try {
        const {
          resolveOrBindWorkspaceSessionForStream,
          persistWorkspaceSessionUserMessage,
        } = await import("../workspace_session_handlers");
        const sessionId = await resolveOrBindWorkspaceSessionForStream({
          chatId: payload.chatId,
        });
        const row = await persistWorkspaceSessionUserMessage(
          sessionId,
          content,
          {},
        );
        qaRowId = row?.id;
      } catch (err) {
        logger.warn("[ask_user] Could not persist Q&A to session:", err);
      }

      if (!insertAskUserAnswerUserMessage(payload.chatId, content, qaRowId)) {
        return { success: false };
      }

      const chat = getStreamTransport(payload.chatId);
      safeSend(event.sender, "chat:response:chunk", {
        chatId: payload.chatId,
        messages: [...(chat?.messages ?? [])],
      });
      return { success: true, restream: true };
    },
  );

  /**
   * MID-TURN USER MESSAGES.
   *
   * The queue lives in MAIN (`user-interjections.ts`), not in a renderer atom,
   * so it survives a reload, cannot be dropped by a chat switch, and is the
   * SAME list in every window. The renderer therefore never holds the truth —
   * it records, cancels, and reads, and repaints from the broadcast below.
   */
  setUserInterjectionNotifier((chatId, pending) => {
    // Every window: the queue is per CHAT, and a chat can be open in more than
    // one. Each window renders only the chats it owns (the same rule the
    // background-job broadcast follows, after that channel got this wrong).
    broadcastToAllWindows("chat:interjections", { chatId, pending });
  });

  ipcMain.handle(
    "chat:interject",
    (_e, payload: { chatId: number; id: string; text: string }) => {
      const entry = recordUserInterjection(Number(payload?.chatId), {
        id: String(payload?.id ?? ""),
        text: String(payload?.text ?? ""),
      });
      return {
        ok: entry != null,
        pending: listPendingUserInterjections(Number(payload?.chatId)),
      };
    },
  );

  ipcMain.handle(
    "chat:interject-cancel",
    (_e, payload: { chatId: number; id: string }) => {
      const chatId = Number(payload?.chatId);
      // False means it was ALREADY DELIVERED, which is not an error — it is the
      // race this design accepts. The renderer treats it as "too late" rather
      // than as a failure, and the returned queue is what it repaints from.
      const ok = cancelUserInterjection(chatId, String(payload?.id ?? ""));
      return { ok, pending: listPendingUserInterjections(chatId) };
    },
  );

  ipcMain.handle("chat:interject-list", (_e, chatId: number) =>
    listPendingUserInterjections(Number(chatId)),
  );

  /**
   * Fallback drain, used when the turn ENDED without another step (the model
   * stopped, so `prepareStep` never ran again). The renderer opens a fresh turn
   * with what comes back.
   *
   * Take-once, sharing the mid-turn drain's counter — so a stream-end flush
   * racing a final step cannot deliver the same words twice. A message is
   * therefore either delivered mid-turn or it opens the next turn; never both,
   * and never neither.
   */
  ipcMain.handle("chat:interject-flush", (_e, chatId: number) => ({
    text: takeUserInterjectionsAsPrompt(Number(chatId)),
  }));
}
