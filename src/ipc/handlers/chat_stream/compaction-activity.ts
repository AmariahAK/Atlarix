/**
 * Compaction activity/banner emitters extracted from chat_stream_handlers.ts.
 * Pure leaves — no module state. (Satellite: never imports the parent handler.)
 */

import log from "electron-log";
import type { IpcMainInvokeEvent } from "electron";
import { safeSend } from "@/ipc/utils/safe_sender";

const logger = log.scope("chat_stream_handlers");

export function emitCompactionMirroredActivity(
  sender: IpcMainInvokeEvent["sender"],
  chatId: number,
): (payload: {
  id: string;
  type: string;
  label: string;
  status: "running" | "done";
  detail?: string;
  timestamp: number;
  chatId: number;
}) => void {
  return (payload) => {
    safeSend(sender, "chat:activity", payload);
    if (
      payload.type === "background" &&
      payload.label === "Summarizing in-task context"
    ) {
      safeSend(sender, "chat:activity", {
        id: `${payload.id}-banner`,
        type: "compaction",
        status: payload.status,
        label:
          payload.status === "running"
            ? "Compressing context to continue..."
            : "Context compressed — continuing task",
        timestamp: Date.now(),
        chatId,
        detail: payload.detail,
      });
    }
  };
}

/**
 * Emit the activity events for a MODEL-INITIATED `compress_context` completion.
 * - `type: "compaction"` drives the raw-IPC banner (CompactionProgressStrip).
 * - `type: "background"` (compress-labelled, status "done") is what
 *   `useCompactionTokenVisuals` listens for to invalidate TOKEN_COUNT_QUERY_KEY,
 *   so the footer/Feed-A meter refreshes mid-turn instead of staying stale until
 *   stream end. (The model path previously emitted only "compaction", which
 *   chat-activity-normalize.ts drops — so Feed A never refreshed.)
 * - When the summarize succeeded but the durable marker did NOT persist, surface
 *   a visible warning instead of failing silently (the reopen-stays-full bug).
 */
export function emitModelCompactionActivity(
  sender: IpcMainInvokeEvent["sender"],
  chatId: number,
  outcome: {
    tokensBefore: number;
    tokensAfter: number;
    status: string;
    success: boolean;
    summaryPersisted: boolean;
    /** Compaction strategy that ran ("summarized" | "pruned" | ... | undefined). */
    strategy?: string;
  },
  reason: string,
): void {
  const base = `compress-context-${chatId}-${Date.now()}`;
  // W6 (v14.8.11): the banner must tell the truth — it used to claim
  // "Context compressed" unconditionally, so a no-op tool call showed a
  // success card while the tool result said nothing happened.
  safeSend(sender, "chat:activity", {
    id: base,
    type: "compaction",
    label: outcome.success ? "Context compressed" : "Context already compact",
    status: "done",
    timestamp: Date.now(),
    detail: outcome.success
      ? `${outcome.tokensBefore} → ${outcome.tokensAfter} tokens (${outcome.status}). ${reason}`
      : `${outcome.tokensBefore} tokens — nothing worth compacting. ${reason}`,
    chatId,
    modelInitiated: true,
  });
  if (outcome.success) {
    safeSend(sender, "chat:activity", {
      id: `${base}-bg`,
      type: "background",
      label: "Context compressed",
      status: "done",
      timestamp: Date.now(),
      detail: `${outcome.tokensBefore} → ${outcome.tokensAfter} tokens`,
      chatId,
    });
    // Only the summarize strategy produces a durable marker; prune/microcompact
    // legitimately persist nothing — warning on those was a false alarm.
    if (outcome.strategy === "summarized" && !outcome.summaryPersisted) {
      logger.warn(
        `[compaction] chat ${chatId}: summary not persisted — reopened session may re-load full history`,
      );
      safeSend(sender, "chat:activity", {
        id: `${base}-warn`,
        type: "background",
        label: "Compaction summary not saved",
        status: "error",
        timestamp: Date.now(),
        detail:
          "The conversation was compressed for this turn, but the durable summary could not be saved — reopening this chat may reload the full history.",
        chatId,
      });
    }
  }
}
