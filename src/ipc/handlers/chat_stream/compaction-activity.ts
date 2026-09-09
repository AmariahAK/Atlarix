/**
 * Compaction activity/banner emitters extracted from chat_stream_handlers.ts.
 * Pure leaves — no module state. (Satellite: never imports the parent handler.)
 */

import log from "electron-log";
import type { IpcMainInvokeEvent } from "electron";
import { safeSend } from "@/ipc/utils/safe_sender";

const logger = log.scope("chat_stream_handlers");

/**
 * ONE emitter for every compaction trigger.
 *
 * WHY THIS EXISTS. v14.39.0 unified compaction into one compactor with three
 * triggers, which was the right consolidation — and left the ANNOUNCING of it
 * hand-rolled at six call sites across four files, with three different labels
 * ("Context compacted automatically", "Context compressed", "Summarizing
 * in-task context") and inconsistent event types.
 *
 * That inconsistency had a user-visible cost, reported 2026-09-02 with the
 * context ring pinned at 100%: **the automatic pre-dispatch compaction emitted
 * only `type: "compaction"`**, which `chat-activity-normalize.ts` drops by
 * design, and never the parallel `background` event. So the trigger that fires
 * without being asked — the one a user is most likely to notice as an
 * unexplained pause — was the only one with no UI at all.
 *
 * Both events, every time, from here:
 *
 * - `background` is the USER-VISIBLE one. It survives normalisation and drives
 *   the mid-stream pill in InlineStreamStatus and `useCompactionTokenVisuals`.
 * - `compaction` is the raw-IPC signal, dropped by the renderer on purpose so
 *   one moment does not produce two activity rows. Kept for any future banner
 *   that reads IPC directly.
 *
 * The LABEL is derived from the trigger and phase rather than passed in, because
 * a per-site label string is precisely how the three variants drifted apart.
 *
 * THE CALLER MUST PASS THE SAME `id` FOR BOTH LEGS OF ONE EPISODE.
 *
 * That is not a style note, it is the whole mechanism by which a compaction
 * leaves ONE row behind instead of two. Both upsert layers key on the id alone —
 * `upsertActivityStreamItem` (chat-activity-normalize.ts) and
 * `upsertStreamThreadItem` (`kind:id`, stream-thread.ts, whose
 * merge-by-running-slot fallback is tools-only) — so a running leg and a done leg
 * with different ids are two independent rows, and
 * `finalizeRunningBackgroundItems` then flips the stranded running row to `done`.
 * The result, reported 2026-09-04: a finished message showing "Compressing
 * context ✓" and "Context compressed ✓" stacked, for one event.
 *
 * These rows PERSIST (activity → thread item → DisplaySnapshotV1 →
 * `session_messages.display_snapshot`), so a duplicate is not transient clutter —
 * it is in the transcript for good.
 *
 * Do NOT try to make the id shared by construction (e.g. chat + trigger):
 * mid-loop compaction can fire more than once in a long turn, and the second
 * episode would silently overwrite the first's row. One id per EPISODE, minted at
 * the call site.
 */
export type CompactionTrigger = "automatic" | "mid-loop" | "model";

export function emitCompactionActivity(
  sender: IpcMainInvokeEvent["sender"],
  chatId: number,
  args: {
    id: string;
    trigger: CompactionTrigger;
    status: "running" | "done" | "error";
    detail?: string;
    /** Set for a completed run that found nothing to do. */
    noop?: boolean;
  },
): void {
  const { id, trigger, status, detail, noop } = args;
  const baseLabel =
    status === "running"
      ? "Compressing context"
      : status === "error"
        ? "Context compression failed"
        : noop
          ? "Context already compact"
          : "Context compressed";
  // The persisted row shows ONLY the label: `streamThreadItemFromActivity` drops
  // `detail`, and AssistantMessageBody renders `summary={item.label}`. So the
  // saving is composed into the label rather than left in a field the thread
  // never carries — which also means no renderer change. `detail` is untouched,
  // because the mid-stream pill renders it separately.
  const label =
    status === "done" && detail ? `${baseLabel} · ${detail}` : baseLabel;
  const base = {
    label,
    status,
    timestamp: Date.now(),
    chatId,
    modelInitiated: trigger === "model",
    ...(detail ? { detail } : {}),
  };
  // The one the renderer reads. `label` must keep matching the compaction filter
  // (/summariz|compress|compact/i) — every label above does.
  safeSend(sender, "chat:activity", {
    ...base,
    id: `${id}-bg`,
    type: "background",
  });
  safeSend(sender, "chat:activity", { ...base, id, type: "compaction" });
}

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
 * - `type: "compaction"` reaches NO renderer, and that is by design:
 *   `chat-activity-normalize.ts` drops the type so one moment does not produce
 *   two rows in the activity atom. It is kept because it is the raw-IPC signal
 *   any future banner would read directly. (This comment used to name a
 *   `CompactionProgressStrip` component, which no longer exists — do not go
 *   looking for it, and do not "fix" the drop; the Bug 1c cases in
 *   compress-context-persistence.test.ts pin it.)
 * - `type: "background"` (compress-labelled) is the USER-VISIBLE one. It drives
 *   BOTH the mid-stream compaction pill in InlineStreamStatus ("Compressing
 *   context…", then "Context compressed" for a few seconds — added v14.41,
 *   because until then a multi-second mid-turn pause had no explanation on
 *   screen) and, at status "done",
 *   `useCompactionTokenVisuals`, which invalidates TOKEN_COUNT_QUERY_KEY
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
  /**
   * The id its RUNNING leg used. Required, not optional: this function used to
   * mint `compress-context-${chatId}-${Date.now()}` here, and a second
   * `Date.now()` guaranteed a different id from the running leg — so the model
   * path left two rows for one compaction just like the automatic path did.
   */
  episodeId: string,
): void {
  const base = episodeId;
  // W6 (v14.8.11) required the banner to tell the truth — it used to claim
  // "Context compressed" unconditionally, so a no-op showed a success card while
  // the tool result said nothing happened. That distinction now lives in
  // `emitCompactionActivity`'s label, in one place, for all three triggers.
  //
  // ALSO FIXED HERE: the `background` event used to be inside `if
  // (outcome.success)`, so a NO-OP emitted only the dropped `compaction` type
  // and was invisible — the same defect the automatic trigger had. The shared
  // emitter always sends both.
  emitCompactionActivity(sender, chatId, {
    id: base,
    trigger: "model",
    status: "done",
    noop: !outcome.success,
    detail: outcome.success
      ? `${outcome.tokensBefore} → ${outcome.tokensAfter} tokens (${outcome.status}). ${reason}`
      : `${outcome.tokensBefore} tokens — nothing worth compacting. ${reason}`,
  });
  if (outcome.success) {
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
