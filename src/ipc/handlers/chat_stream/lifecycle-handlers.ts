/**
 * Stream lifecycle IPC handlers extracted from registerChatStreamHandlers:
 * chat:cancel, chat:abort, chat:stream:reconnect, chat:edit-message. Registered
 * by the parent, which passes the live `chatStreamHandler` (reconnect
 * re-dispatches it). These are self-contained callbacks — no shared turn
 * context — reaching the shared state via ./stream-state.
 *
 * (Satellite: never imports the parent handler.)
 */

import { ipcMain } from "electron";
import log from "electron-log";
import { safeSend } from "@/ipc/utils/safe_sender";
import type { ChatResponseEnd } from "@/ipc/ipc_types";
import { FileUploadsState } from "@/ipc/utils/file_uploads_state";
import { killForegroundCommandsForChat } from "@/lib/agent/background-commands";
import { cancelAllSubagentTasksForChat } from "@/lib/tools/spawn-task";
import {
  activeStreams,
  lastStreamRequest,
  streamTurnIdByChatId,
  markChatUserStopped,
  type ChatStreamHandlerFn,
} from "./stream-state";

const logger = log.scope("chat_stream_handlers");

/** Register cancel/abort/reconnect/edit-message. `chatStreamHandler` is the live
 * chat:stream handler (reconnect re-dispatches the cached request through it). */
export function registerLifecycleHandlers(
  chatStreamHandler: ChatStreamHandlerFn,
): void {
  // Handler to cancel an ongoing stream
  ipcMain.handle("chat:cancel", async (event, chatId: number) => {
    // Latch the stop HERE, in main, not only in the renderer that pressed it.
    // The end event below goes to `event.sender` alone, so any other window kept
    // its own "not stopped" view of this chat and would happily wake it when a
    // background job reported in — restarting the agent the user had just stopped.
    // Released when the user next sends something with real content.
    markChatUserStopped(chatId);

    const abortController = activeStreams.get(chatId);

    if (abortController) {
      // Abort the stream
      abortController.abort();
      activeStreams.delete(chatId);
      logger.log(`Aborted stream for chat ${chatId}`);
    } else {
      logger.warn(`No active stream found for chat ${chatId}`);
    }

    // Fix 4: aborting the model stream doesn't stop a blocking foreground
    // run_command or running scout sub-agents — terminate them too so "stop"
    // actually stops the work (and stops spending tokens).
    const killed = killForegroundCommandsForChat(chatId);
    const subagentsCancelled = cancelAllSubagentTasksForChat(chatId);
    if (killed > 0 || subagentsCancelled > 0) {
      logger.log(
        `[chat:cancel] Stopped ${killed} command(s) + ${subagentsCancelled} sub-agent(s) for chat ${chatId}`,
      );
    }

    // Send the end event to the renderer.
    //
    // `userCancelled` is what stops this end from re-launching the work. The renderer
    // auto-wakes a fresh turn whenever a background command or sub-agent still has a
    // pending result, and we only killed FOREGROUND commands above — so that condition
    // is routinely true here. Any pending results are deliberately KEPT: background work
    // finishes quietly and `takePendingBackgroundCommandResults` /
    // `takePendingSubagentResults` drain it into the user's NEXT turn, which is
    // wake-independent. So nothing is lost by not waking.
    safeSend(event.sender, "chat:response:end", {
      chatId,
      updatedFiles: false,
      hadToolCallsOrPermissions: false,
      userCancelled: true,
      // Report the stopped turn's snapshot id so Revert is OFFERED. The writes it
      // already made are on disk (the interceptor captures pre-write bytes at write
      // time); only the renderer's knowledge of the id was missing, and without it the
      // affordance is hidden on precisely the turn the user stopped for making a bad
      // edit. `updatedFiles: false` above is about the *file-tree refresh*, not about
      // whether anything was written.
      ...(streamTurnIdByChatId.get(chatId)
        ? { snapshotTurnId: streamTurnIdByChatId.get(chatId) }
        : {}),
    } satisfies ChatResponseEnd);

    // Clean up uploads state for this chat
    try {
      FileUploadsState.getInstance().clear(chatId);
    } catch { }

    return true;
  });

  // ═══════════════════════════════════════════════════════════
  // ABORT STREAM - User can cancel AI stream to save tokens
  // ═══════════════════════════════════════════════════════════
  ipcMain.handle("chat:abort", async (_, chatId: number) => {
    const controller = activeStreams.get(chatId);
    if (controller) {
      logger.log(`[chat:abort] User cancelled stream for chat ${chatId}`);
      controller.abort();
      activeStreams.delete(chatId);
      // Fix 4: also terminate any blocking foreground run_command + running
      // scout sub-agents so cancel stops in-flight work, not just the request.
      const killed = killForegroundCommandsForChat(chatId);
      const subagentsCancelled = cancelAllSubagentTasksForChat(chatId);
      if (killed > 0 || subagentsCancelled > 0) {
        logger.log(
          `[chat:abort] Stopped ${killed} command(s) + ${subagentsCancelled} sub-agent(s) for chat ${chatId}`,
        );
      }
      // Do NOT delete partialResponses here — the stream's catch block will persist
      // the partial response to the DB and then clear it, so the user keeps the
      // cancelled response when they send a follow-up.
      return { success: true, message: 'AI response cancelled' };
    }
    return { success: false, message: 'No active stream for this chat' };
  });

  // FIX 4: explicit "reconnect" after the auto-retry sequence gave up. The
  // renderer holds onto the partial; we just re-dispatch the same turn.
  // Asks the renderer to clear its in-flight stream buffer first, then runs
  // the chat-stream handler again with the cached request.
  ipcMain.handle(
    "chat:stream:reconnect",
    async (event, params: { chatId: number }) => {
      const chatId = params?.chatId;
      if (typeof chatId !== "number") {
        return { success: false, message: "Invalid chatId" };
      }
      const cached = lastStreamRequest.get(chatId);
      if (!cached) {
        return {
          success: false,
          message: "No prior stream request to reconnect",
        };
      }
      safeSend(event.sender, "chat:stream:reset-partial", { chatId });
      try {
        await chatStreamHandler(event, cached);
        return { success: true };
      } catch (error) {
        logger.error("[chat:stream:reconnect] re-dispatch failed:", error);
        return {
          success: false,
          message: error instanceof Error ? error.message : String(error),
        };
      }
    },
  );

  // v3.9: Edit user message — truncate messages after it, update content, clear has_answered_questions
  ipcMain.handle(
    "chat:edit-message",
    async (
      event,
      payload: { chatId: number; userMessageId: number; newContent: string }
    ) => {
      const { chatId, userMessageId, newContent } = payload;
      // Ephemeral chats (chatId < 0) live only in-memory (ephemeral-chat transport).
      const { editTransportUserMessage, getStreamTransport } = await import(
        "@/lib/chat/stream-transport"
      );
      // v12 0.4-C3: edits target the DB row DIRECTLY via the message's
      // sessionRowId (every persisted message carries it — streamed user
      // messages since C2, ask_user Q→A inserts since C3). The ordinal
      // fallback is deleted. A message WITHOUT a row id was never persisted
      // (best-effort persist failed) — surface that instead of silently
      // diverging.
      const chat = getStreamTransport(chatId);
      const targetMsg = chat?.messages.find(
        (m) => m.id === userMessageId && m.role === "user",
      );
      const sessionRowId = targetMsg?.sessionRowId;

      // W2 (v14.8.11): regenerate the MODEL-facing content for the edited
      // message — expand its attachment stubs back to full bodies using the
      // message's stored paste metas. Without this the transport dropped the
      // bodies (model lost inline attachment content on resend) and the DB
      // kept the STALE pre-edit modelContent (dispatch prefers it → the edit
      // was silently undone for the model after a reload).
      let newModelContent: string | null = null;
      try {
        const {
          resolvePasteAttachmentsForMessage,
          expandAttachmentStubsToModelContent,
        } = await import("@/lib/chat/paste-attachment-meta");
        const pastes = resolvePasteAttachmentsForMessage({
          pasteAttachments: targetMsg?.pasteAttachments ?? null,
          modelContent: targetMsg?.modelContent ?? null,
        });
        const expanded = expandAttachmentStubsToModelContent(newContent, pastes);
        newModelContent = expanded !== newContent ? expanded : null;
      } catch (e) {
        logger.warn("Failed to regenerate model content for edited message:", e);
      }

      const ok = editTransportUserMessage(
        chatId,
        userMessageId,
        newContent,
        newModelContent,
      );
      if (!ok) {
        throw new Error("Ephemeral user message not found");
      }

      let persistedToSession = false;
      try {
        if (sessionRowId) {
          const { persistEditedSessionMessageById } = await import(
            "../workspace_session_handlers"
          );
          persistedToSession =
            (await persistEditedSessionMessageById(
              sessionRowId,
              newContent,
              newModelContent,
            )) === "updated";
        }
      } catch (e) {
        logger.warn("Failed to persist edited session message:", e);
      }
      if (!persistedToSession) {
        logger.warn(
          `[chat:edit-message] edit not persisted to session (chat ${chatId}, sessionRowId=${sessionRowId ?? "none"})`,
        );
        safeSend(event.sender, "chat:activity", {
          id: `edit-not-persisted-${chatId}-${Date.now()}`,
          type: "warning",
          label: "Edit not saved to session history",
          detail:
            "The edit applies to this conversation, but the saved session could not be updated — after a reload the original message may reappear.",
          status: "error",
          timestamp: Date.now(),
          chatId,
        });
      }
      return { success: true, persistedToSession };
    }
  );
}
