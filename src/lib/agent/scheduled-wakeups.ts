/**
 * R1 — model-scheduled self-wake.
 *
 * The model may call `schedule_wakeup` to ask the harness to re-engage the turn
 * loop after a delay — for re-checking external state the harness can't observe
 * on its own (a deploy, a remote queue, a long job with no completion signal).
 *
 * This is purely OPT-IN and fallback-safe: if the model never schedules one,
 * nothing changes — finished background jobs / sub-agents and stall advisories
 * still auto-wake an idle chat. A fired wake-up reuses the SAME auto-wake path
 * as those (notifier → `chat:background-job-update` with source:"scheduled" →
 * useStreamChat), and its re-check nudge is delivered via the prepareStep seam.
 *
 * In-memory only (lost on app restart) — same as the background-command and
 * sub-agent registries. Timers are unref'd so they never keep the app alive.
 */

/** Clamp window for a self-wake delay. */
const MIN_DELAY_MS = 60_000; // 60s
const MAX_DELAY_MS = 14_400_000; // 4h — long builds/test-suites/deploys can exceed 1h
/** Cap outstanding timers + queued nudges per chat (anti busy-loop). */
const MAX_PENDING_PER_CHAT = 8;

interface ScheduledWakeup {
  id: string;
  note: string;
  firesAt: number;
  timer: ReturnType<typeof setTimeout>;
}

const timersByChat = new Map<number, Map<string, ScheduledWakeup>>();
const nudgesByChat = new Map<number, string[]>();
/** Monotonic counter for ids (avoids Math.random). */
let seq = 0;

type Notifier = (
  chatId: number,
  ev: { operationId: string; status: "scheduled" },
) => void;
let notifier: Notifier | null = null;

export function setScheduledWakeupNotifier(fn: Notifier): void {
  notifier = fn;
}

/** Clamp a requested delay into the allowed window. */
export function clampWakeupDelayMs(ms: number): number {
  if (!Number.isFinite(ms)) return MIN_DELAY_MS;
  return Math.min(MAX_DELAY_MS, Math.max(MIN_DELAY_MS, Math.round(ms)));
}

/**
 * Schedule a self-wake. Returns the id + the (clamped) delay actually used, or
 * an error when the chat already has too many outstanding wake-ups.
 */
export function scheduleWakeup(
  chatId: number,
  delayMs: number,
  note: string,
): { id: string; firesInMs: number } | { error: string } {
  let chatTimers = timersByChat.get(chatId);
  if (chatTimers && chatTimers.size >= MAX_PENDING_PER_CHAT) {
    return {
      error: `Too many scheduled wake-ups for this chat (max ${MAX_PENDING_PER_CHAT}); wait for one to fire or cancel work.`,
    };
  }
  const clamped = clampWakeupDelayMs(delayMs);
  const id = `wake-${chatId}-${++seq}`;
  const trimmedNote = note?.trim() ? note.trim() : "(no note)";
  const timer = setTimeout(() => {
    timersByChat.get(chatId)?.delete(id);
    const list = nudgesByChat.get(chatId) ?? [];
    list.push(trimmedNote);
    nudgesByChat.set(chatId, list.slice(-MAX_PENDING_PER_CHAT));
    notifier?.(chatId, { operationId: id, status: "scheduled" });
  }, clamped);
  // Don't keep the process alive just for a self-wake (Node only).
  (timer as { unref?: () => void }).unref?.();
  if (!chatTimers) {
    chatTimers = new Map();
    timersByChat.set(chatId, chatTimers);
  }
  chatTimers.set(id, { id, note: trimmedNote, firesAt: Date.now() + clamped, timer });
  return { id, firesInMs: clamped };
}

/**
 * Take-once drain of fired self-wake nudges for a chat, formatted as a
 * model-facing block delivered via the prepareStep seam. A nudge is guidance
 * by nature ("re-check now"), so — unlike a finished result (R2) — it is NOT a
 * forced tool-result; the model decides what to do.
 */
export function takePendingScheduledWakeupNudges(chatId: number): string | null {
  const list = nudgesByChat.get(chatId);
  if (!list?.length) return null;
  nudgesByChat.delete(chatId);
  return [
    `[Scheduled re-check]`,
    `A wake-up you scheduled has fired. Re-check the relevant state now and continue — if it's still not ready, schedule another check or stop waiting.`,
    list.map((n) => `- ${n}`).join("\n"),
  ].join("\n\n");
}

/** Non-destructive: any fired-but-undrained nudges queued for this chat? */
export function hasPendingScheduledWakeupNudges(chatId: number): boolean {
  return (nudgesByChat.get(chatId)?.length ?? 0) > 0;
}

/**
 * Is there an OUTSTANDING (scheduled-but-not-yet-fired) self-wake for this chat?
 * A fired timer removes itself from `timersByChat` (see setTimeout body), so a
 * non-empty map means the model committed to waiting until at least one wake-up
 * fires. The stall watchdog uses this to hush its "gone quiet, may be stuck"
 * advisory while the model is deliberately waiting — the wake-up is the single
 * authority, not a competing 3-min ping.
 */
export function hasActiveScheduledWakeup(chatId: number): boolean {
  return (timersByChat.get(chatId)?.size ?? 0) > 0;
}

/** Cancel all timers + drop queued nudges for a chat (on chat close/delete). */
export function clearScheduledWakeupsForChat(chatId: number): void {
  const chatTimers = timersByChat.get(chatId);
  if (chatTimers) {
    for (const w of chatTimers.values()) clearTimeout(w.timer);
    timersByChat.delete(chatId);
  }
  nudgesByChat.delete(chatId);
}
