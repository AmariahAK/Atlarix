/**
 * Telling the model when its own history was reduced.
 *
 * WHAT THIS FILE USED TO BE
 * A turn-count history cap: `history.length > (maxChatTurns + 1) * 2` → drop the
 * oldest messages. It ran on every dispatch, and a production session on a
 * 1,000,000-token window went
 *
 *   Total tokens used: 124,907
 *   Limiting chat history from 23 to 21 messages (max 11 turns)
 *   Total tokens used:  57,832
 *
 * — half the conversation deleted at 8.9% context fill, because it crossed ELEVEN
 * TURNS. A count has no relationship to a context window: a 40,000-token file read
 * and a one-word "thanks" counted the same, and the two oldest messages in an
 * agentic session are exactly the bulky ones.
 *
 * WHY THE CAP IS GONE RATHER THAN FIXED
 * The setting that supposedly gated it (`enableContextAutoSummarize`) was never
 * checked, so the "fallback" was the primary path for everyone. Worse, that same
 * setting gated COMPACTION — so the only way to opt out of summarization was to
 * get blunt deletion instead, with no summary and no marker. There was no
 * configuration in which the cap was the right behaviour. Context is now bounded
 * solely by the token budget:
 *
 *   resolveModelContextLimit → enforceContextBudget → mid-loop compaction (0.9)
 *
 * all of which measure tokens and always run.
 *
 * WHAT REMAINS HERE
 * The token budget can still DROP messages rather than summarize them (its
 * head-trim step runs before it reaches for the LLM summarizer). That drop is
 * silent to the model, which is the part that actually costs accuracy — a model
 * that doesn't know it lost context fills the hole by guessing instead of
 * re-reading. This module carries that notice.
 */

/**
 * What the model is told when history was removed underneath it.
 *
 * Delivered through the same out-of-band `<system-reminder>` seam as background
 * results and corrections. Compaction does not need this — a summary is visible
 * in the history and announces itself. A deletion announces nothing.
 */
export function droppedHistoryNotice(droppedCount: number): string {
  return [
    `${droppedCount} earlier message${droppedCount === 1 ? "" : "s"} in this conversation ` +
      `${droppedCount === 1 ? "was" : "were"} removed to fit the context window.`,
    "Do not assume you still have that detail. If you need something from earlier in the session, re-read the relevant files or ask the user rather than recalling it.",
  ].join(" ");
}

// ── Take-once delivery queue ────────────────────────────────────────────────
// Same contract as the other harness nudges (background results, corrections,
// scheduled wake-ups): the producer queues, `prepareStep` drains exactly once so
// the notice reaches the model on its very next step and never repeats.

const pendingDroppedCounts = new Map<number, number>();

/** Record that `droppedCount` messages were removed from this chat's history. */
export function queueDroppedHistoryNotice(
  chatId: number,
  droppedCount: number,
): void {
  if (droppedCount <= 0) return;
  // Accumulate: the budget can trim more than once before a single dispatch, and
  // the model should hear one honest total rather than several partial claims.
  pendingDroppedCounts.set(
    chatId,
    (pendingDroppedCounts.get(chatId) ?? 0) + droppedCount,
  );
}

/** Drain the pending notice for this chat, or null when nothing was dropped. */
export function takePendingDroppedHistoryNotice(chatId: number): string | null {
  const count = pendingDroppedCounts.get(chatId);
  if (!count) return null;
  pendingDroppedCounts.delete(chatId);
  return droppedHistoryNotice(count);
}

/** Test-only: clear the queue between cases. */
export function __resetDroppedHistoryNoticesForTests(): void {
  pendingDroppedCounts.clear();
}
