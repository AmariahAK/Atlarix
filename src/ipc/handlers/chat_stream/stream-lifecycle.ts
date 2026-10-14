/**
 * Stream lifecycle satellites extracted from chat_stream_handlers.ts: mode-change
 * resolution, end-turn ask_user handling, crash-safe interrupted-draft flush, and
 * the teardown/abort routines. These are the state-COUPLED helpers — they read
 * and mutate the shared Maps in ./stream-state.
 *
 * (Satellite: never imports the parent handler. It imports state from
 * ./stream-state and leaf utilities only — no cycle.)
 */

import * as crypto from "crypto";
import log from "electron-log";
import type { IpcMainInvokeEvent } from "electron";
import { safeSend } from "@/ipc/utils/safe_sender";
import {
  streamStopAbortReason,
  ASK_USER_STREAM_STOP,
  TEARDOWN_STREAM_STOP,
} from "@/lib/stream/stream-stop-sentinels";
import { stripThinkBlocks } from "@/ipc/utils/thinking_tags";
import { clearWaitTrackersForChat } from "../permissions/handlers";
import { clearScheduledWakeupsForChat } from "@/lib/agent/scheduled-wakeups";
import { killForegroundCommandsForChat } from "@/lib/agent/background-commands";
import { cancelAllSubagentTasksForChat } from "@/lib/tools/spawn-task";
import { getStreamTransportAppId } from "@/lib/chat/stream-transport";
import {
  activeStreams,
  activeStreamRuns,
  activeStreamId,
  partialResponses,
  lastStreamRequest,
  pendingModeChangeResolvers,
  pendingAskUserArtifactByChatId,
  partialDraftRowByChatId,
  partialDraftLastFlushAtByChatId,
  streamSessionByChatId,
  streamTurnIdByChatId,
  PARTIAL_DRAFT_FLUSH_INTERVAL_MS,
} from "./stream-state";

const logger = log.scope("chat_stream_handlers");

export function resolveModeChange(chatId: number, approve: boolean): void {
  const r = pendingModeChangeResolvers.get(chatId);
  if (r) {
    r.finish(approve);
  }
}

/**
 * v11.1 end-turn ask_user: detect the `__ask_user` marker, persist the
 * pending questions for the turn's content, notify the renderer, and END the
 * turn (graceful abort — same machinery as task-complete). No blocking wait,
 * no 30-minute timeout: the user's answers come back as the next user message
 * and a fresh stream continues.
 */
export async function resolveAskUserToolResult(
  event: IpcMainInvokeEvent,
  chatId: number,
  toolName: string,
  result: unknown,
  hooks?: { onAskUserEndTurn?: () => void },
): Promise<string | null> {
  if (toolName !== "ask_user") return null;
  // Accept the marker both raw and nested inside a registry success envelope
  // (`{ success, result: { __ask_user } }`) — defensive against wrappers.
  let marker = result;
  if (
    marker &&
    typeof marker === "object" &&
    (marker as { __ask_user?: boolean }).__ask_user !== true &&
    (marker as { result?: unknown }).result &&
    typeof (marker as { result?: unknown }).result === "object" &&
    (marker as { result: { __ask_user?: boolean } }).result.__ask_user === true
  ) {
    marker = (marker as { result: unknown }).result;
  }
  if (
    !marker ||
    typeof marker !== "object" ||
    (marker as { __ask_user?: boolean }).__ask_user !== true
  ) {
    return null;
  }
  const q = marker as {
    question: string;
    options?: string[];
    questions?: Array<{ question: string; options?: string[] }>;
  };
  const questions =
    Array.isArray(q.questions) && q.questions.length > 0
      ? q.questions
      : [
          {
            question: q.question ?? "",
            ...(Array.isArray(q.options) && q.options.length > 0
              ? { options: q.options }
              : {}),
          },
        ];
  // v12 3.1: collision-free id (was Date.now()+Math.random — ms collisions).
  const questionId = `uq_${crypto.randomUUID()}`;
  pendingAskUserArtifactByChatId.set(chatId, { questionId, questions });
  safeSend(event.sender, "user-question-request", {
    chatId,
    questionId,
    question: questions[0].question,
    options: questions[0].options,
    questions,
  });
  logger.log(
    `[ask_user] Questions presented (${questionId}, ${questions.length}) — ending turn; answers arrive as the next message`,
  );
  hooks?.onAskUserEndTurn?.();
  activeStreams.get(chatId)?.abort(streamStopAbortReason(ASK_USER_STREAM_STOP));
  // Returned as the tool result only if the abort races the SDK — it tells
  // the model (and any transcript) what happened without inventing answers.
  return JSON.stringify({
    success: true,
    questions: questions.map((it) => it.question),
    status:
      "Questions presented to the user. This turn ends here; the user's answers will arrive in the next message.",
  });
}

/**
 * v12 (TODO 2.4): main-process memory-leak cleanup on session delete. These
 * per-chat maps were only ever overwritten, never pruned — each deleted chat
 * leaked its last request, partial response, loaders and ask_user state for
 * the lifetime of the process.
 */
export function clearChatStreamStateForChat(chatId: number): void {
  const active = activeStreams.get(chatId);
  if (active) {
    try {
      active.abort(streamStopAbortReason(TEARDOWN_STREAM_STOP));
    } catch {
      /* noop */
    }
    activeStreams.delete(chatId);
  }
  activeStreamId.delete(chatId);
  partialResponses.delete(chatId);
  lastStreamRequest.delete(chatId);
  pendingAskUserArtifactByChatId.delete(chatId);
  partialDraftRowByChatId.delete(chatId);
  partialDraftLastFlushAtByChatId.delete(chatId);
  streamSessionByChatId.delete(chatId);
  // Deleted HERE (session delete) and nowhere else: `chat:cancel` reads this to report
  // the turn id on a stopped end, so clearing it on turn teardown would race the very
  // path it exists for. Overwritten each turn, so it holds one string per live chat.
  streamTurnIdByChatId.delete(chatId);
  // v13 7B: clear any pending waiting-on-command timers + chips.
  clearWaitTrackersForChat(chatId);
  // R1: cancel any outstanding self-wake timers for this chat.
  clearScheduledWakeupsForChat(chatId);
}

export async function flushInterruptedDraft(
  chatId: number,
  sessionId: string,
  content: string,
  opts?: { force?: boolean; modelContent?: string },
): Promise<void> {
  // Throttle BEFORE stripping: this runs on every streamed token, and the strip
  // is a regex over the whole turn so far.
  const now = Date.now();
  const last = partialDraftLastFlushAtByChatId.get(chatId) ?? 0;
  if (!opts?.force && now - last < PARTIAL_DRAFT_FLUSH_INTERVAL_MS) return;
  const text = stripThinkBlocks(content).trim();
  if (!text) return;
  partialDraftLastFlushAtByChatId.set(chatId, now);
  try {
    const { upsertInterruptedAssistantDraft } = await import(
      "../workspace_session_handlers"
    );
    const rowId = await upsertInterruptedAssistantDraft(
      partialDraftRowByChatId.get(chatId) ?? null,
      sessionId,
      text,
      opts?.modelContent,
    );
    partialDraftRowByChatId.set(chatId, rowId);
  } catch (e) {
    logger.warn(`[partial-draft] upsert failed for chat ${chatId}:`, e);
  }
}

/**
 * Keep the interrupted draft row as the stopped turn's record and forget it
 * here, so the chat's next turn writes a new draft instead of overwriting this
 * one (and deleting it when that turn completes).
 */
export function keepInterruptedDraft(chatId: number): void {
  partialDraftRowByChatId.delete(chatId);
  partialDraftLastFlushAtByChatId.delete(chatId);
}

/** Delete the interrupted draft for a chat (turn completed cleanly / superseded). */
export async function clearInterruptedDraft(chatId: number): Promise<void> {
  const rowId = partialDraftRowByChatId.get(chatId);
  partialDraftRowByChatId.delete(chatId);
  partialDraftLastFlushAtByChatId.delete(chatId);
  if (!rowId) return;
  try {
    const { deleteInterruptedAssistantDraft } = await import(
      "../workspace_session_handlers"
    );
    await deleteInterruptedAssistantDraft(rowId);
  } catch (e) {
    logger.warn(`[partial-draft] delete failed for chat ${chatId}:`, e);
  }
}

/**
 * Force-persist every in-flight stream's partial output as an interrupted row.
 * Called from main.ts on `before-quit` and powerMonitor `suspend` so a full
 * system suspend / app quit never loses work-in-progress.
 */
export async function flushPartialStreamsForShutdown(): Promise<void> {
  const entries = [...partialResponses.entries()];
  if (entries.length === 0) return;
  logger.info(
    `[partial-draft] shutdown flush for ${entries.length} active stream(s)`,
  );
  for (const [chatId, content] of entries) {
    const sessionId = streamSessionByChatId.get(chatId);
    if (!sessionId) continue;
    try {
      await flushInterruptedDraft(chatId, sessionId, content, { force: true });
    } catch (e) {
      logger.warn(
        `[partial-draft] shutdown flush failed for chat ${chatId}:`,
        e,
      );
    }
  }
}

/**
 * Abort all active AI streams - call on app quit to save tokens
 */
export function abortAllStreams(): void {
  const count = activeStreams.size;
  if (count === 0) return;

  logger.log(`[Cleanup] Aborting ${count} active AI streams to save tokens...`);

  for (const [chatId, controller] of activeStreams.entries()) {
    try {
      controller.abort(streamStopAbortReason(TEARDOWN_STREAM_STOP));
      logger.log(`[Cleanup] Aborted stream for chat ${chatId}`);
    } catch (error) {
      logger.warn(`[Cleanup] Error aborting stream ${chatId}:`, error);
    }
  }

  activeStreams.clear();
  activeStreamRuns.clear();
  activeStreamId.clear();
  partialResponses.clear();
  logger.log(`[Cleanup] All AI streams aborted`);
}

/**
 * Abort every live turn belonging to a workspace, because that workspace is
 * being deleted.
 *
 * THE BUG THIS EXISTS FOR: `delete-app` stopped the dev server and cascaded the
 * chat rows but never touched `activeStreams`. So a Build turn could be
 * mid-`run_command` against a folder while `rm -rf` ran over it, and whatever it
 * wrote next went to a chat row that no longer existed. Nothing reported any of
 * that — the turn simply failed somewhere deep, in a window still showing a
 * working sidebar.
 *
 * Call it BEFORE the files are removed, not after: the point is to stop the
 * commands, and stopping them once the directory is already gone stops nothing.
 *
 * Built on `cancelStreamForAutomation` rather than beside it, so a workspace
 * deletion tears down exactly what an automation timeout does — the abort, the
 * registry entry, the blocking foreground commands, and the sub-agent tasks.
 * Returns how many turns it stopped, so the window that has to explain itself
 * can say whether there was anything to explain.
 */
export function cancelStreamsForApp(appId: number): number {
  let cancelled = 0;
  // Snapshot first: `cancelStreamForAutomation` deletes from `activeStreams`,
  // and mutating a Map while iterating its keys is how you miss half of them.
  for (const chatId of [...activeStreams.keys()]) {
    if (getStreamTransportAppId(chatId) !== appId) continue;
    cancelStreamForAutomation(chatId);
    cancelled++;
  }
  if (cancelled > 0) {
    logger.log(
      `[workspace-deleted] aborted ${cancelled} live turn(s) for app ${appId}`,
    );
  }
  return cancelled;
}

/**
 * Abort a stream without an IPC event (automation timeout path). Also stops
 * blocking foreground commands + scout sub-agents, mirroring chat:cancel.
 */
export function cancelStreamForAutomation(chatId: number): void {
  const abortController = activeStreams.get(chatId);
  if (abortController) {
    abortController.abort(streamStopAbortReason(TEARDOWN_STREAM_STOP));
    activeStreams.delete(chatId);
    logger.log(`[automation] Aborted stream for chat ${chatId}`);
  }
  killForegroundCommandsForChat(chatId);
  cancelAllSubagentTasksForChat(chatId);
}
