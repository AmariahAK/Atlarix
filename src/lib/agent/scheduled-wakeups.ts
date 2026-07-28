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
  /** Set when this wake-up is tied to a specific background job (Part 2). A
   * job-tied wake-up is auto-cancelled when the job finishes and its fired
   * nudge names the job so the model re-checks that exact job. */
  jobId?: string;
}

/**
 * A nudge that has already FIRED and is waiting to be drained.
 *
 * Keeps `jobId` because a fired nudge outlives its timer: the timer removes
 * itself from `timersByChat` when it fires, so `cancelJobWakeups` — which only
 * walks that map — could not reach an already-queued nudge. A job that finished
 * after its timer fired therefore still got re-checked, which is the exact
 * "it pings even though the task was done" symptom. Carrying the id lets a
 * finishing job purge its own queued nudges.
 */
interface QueuedNudge {
  text: string;
  jobId?: string;
}

const timersByChat = new Map<number, Map<string, ScheduledWakeup>>();
const nudgesByChat = new Map<number, QueuedNudge[]>();
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
  return scheduleInternal(chatId, delayMs, note, undefined);
}

/** Shared scheduler for both free-standing self-wakes and job-tied timers. */
function scheduleInternal(
  chatId: number,
  delayMs: number,
  note: string,
  jobId: string | undefined,
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
  // A job-tied nudge names the job so the model re-checks that exact job.
  const nudgeText = jobId ? `job "${jobId}": ${trimmedNote}` : trimmedNote;
  const timer = setTimeout(() => {
    timersByChat.get(chatId)?.delete(id);
    const list = nudgesByChat.get(chatId) ?? [];
    list.push({ text: nudgeText, ...(jobId ? { jobId } : {}) });
    nudgesByChat.set(chatId, list.slice(-MAX_PENDING_PER_CHAT));
    notifier?.(chatId, { operationId: id, status: "scheduled" });
  }, clamped);
  // Don't keep the process alive just for a self-wake (Node only).
  (timer as { unref?: () => void }).unref?.();
  if (!chatTimers) {
    chatTimers = new Map();
    timersByChat.set(chatId, chatTimers);
  }
  chatTimers.set(id, { id, note: trimmedNote, firesAt: Date.now() + clamped, timer, jobId });
  return { id, firesInMs: clamped };
}

// ── Job-tied wake timers (Part 2) ────────────────────────────────────────────
// A live countdown the model can see + adjust on a specific background job.
// Backed by the same registry (so `firesAt − now` is the "96s left" value); a
// finished job cancels its timer (see background-commands.recordBackground
// CommandResult) so timers can't orphan or pile up.

/** Find the (single) outstanding wake-up tied to a job, if any. */
function findJobWakeup(chatId: number, jobId: string): ScheduledWakeup | undefined {
  const chatTimers = timersByChat.get(chatId);
  if (!chatTimers) return undefined;
  for (const w of chatTimers.values()) if (w.jobId === jobId) return w;
  return undefined;
}

/**
 * Set (or REPLACE — dedupe) the wake timer for a background job. Any existing
 * timer for that job is cancelled first so a job never accumulates multiple
 * timers. Returns the clamped delay actually used, or an error if the chat is
 * at its wake-up cap.
 */
export function setJobWakeup(
  chatId: number,
  jobId: string,
  delayMs: number,
  note: string,
): { firesInMs: number } | { error: string } {
  cancelJobWakeups(chatId, jobId);
  const res = scheduleInternal(chatId, delayMs, note, jobId);
  if ("error" in res) return res;
  return { firesInMs: res.firesInMs };
}

/**
 * Adjust a job's existing timer by a delta (positive = later, negative =
 * sooner), clamped to the 60s–4h window off the CURRENT remaining time.
 * Returns the new remaining ms, or null if the job has no timer.
 */
export function adjustJobWakeup(
  chatId: number,
  jobId: string,
  deltaMs: number,
): { firesInMs: number } | null {
  const existing = findJobWakeup(chatId, jobId);
  if (!existing) return null;
  const remaining = Math.max(0, existing.firesAt - Date.now());
  const res = setJobWakeup(chatId, jobId, remaining + deltaMs, existing.note);
  if ("error" in res) return null;
  return { firesInMs: res.firesInMs };
}

/** Live "time left" on a job's timer, or null if it has none. */
export function getJobWakeupRemainingMs(chatId: number, jobId: string): number | null {
  const existing = findJobWakeup(chatId, jobId);
  if (!existing) return null;
  return Math.max(0, existing.firesAt - Date.now());
}

/**
 * Cancel everything tied to a job — pending timers AND already-fired nudges.
 *
 * Both halves matter. Clearing only the timers left a fired-but-undrained nudge
 * in the queue, so a job that finished after its countdown elapsed still asked
 * the model to "re-check" a job whose result had already been delivered.
 *
 * Called on adjust-replace (where only the timer half can exist) and on job
 * finish (`recordBackgroundCommandResult`), where either half can.
 */
export function cancelJobWakeups(chatId: number, jobId: string): number {
  let cancelled = 0;

  const chatTimers = timersByChat.get(chatId);
  if (chatTimers) {
    for (const [id, w] of chatTimers) {
      if (w.jobId === jobId) {
        clearTimeout(w.timer);
        chatTimers.delete(id);
        cancelled++;
      }
    }
  }

  const queued = nudgesByChat.get(chatId);
  if (queued?.length) {
    const kept = queued.filter((n) => n.jobId !== jobId);
    cancelled += queued.length - kept.length;
    if (kept.length) nudgesByChat.set(chatId, kept);
    else nudgesByChat.delete(chatId);
  }

  return cancelled;
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
    list.map((n) => `- ${n.text}`).join("\n"),
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
