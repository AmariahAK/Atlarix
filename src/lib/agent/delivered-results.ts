/**
 * Background results the model was shown by injection, kept for the next turns.
 *
 * A finished command's output or a sub-agent's report reaches the model in one
 * of two ways. On a wake turn of a model that cannot be forced to call a tool
 * (one that reasons natively), it is injected into that turn's step input, and
 * that injection is never saved. So the turn AFTER no longer had it. Observed
 * (QA, 2026-10-12): two background sub-agents finished one after the other; the
 * second wake said the first report "wasn't in the visible transcript" and
 * spent ten tool calls re-deriving it.
 *
 * What was delivered that way is remembered here and offered to the next two
 * turns as a bounded context section. (The forced `collect_results` path needs
 * none of this: its result is a real tool result in the saved history.)
 */

type Entry = { text: string; at: number; shown: number };

const byChat = new Map<number, Entry[]>();

/** Offered to this many turns after the one that received it. */
const TURNS = 2;
const MAX_ENTRIES = 4;
const MAX_CHARS = 12_000;

/** A result block was injected into a turn: keep it for the turns after. */
export function rememberDeliveredResults(chatId: number, text: string | null, now = Date.now()): void {
  if (!text?.trim()) return;
  const list = byChat.get(chatId) ?? [];
  list.push({ text: text.trim(), at: now, shown: 0 });
  while (list.length > MAX_ENTRIES) list.shift();
  byChat.set(chatId, list);
}

/**
 * The results delivered in earlier turns, for this turn's context, newest last
 * and cut to a budget. Counts as one showing; after `TURNS` showings an entry
 * is gone. Results delivered during THIS turn are not offered back to it.
 */
export function takeEarlierDeliveredResults(chatId: number, turnStartedAt = Date.now()): string | null {
  const list = byChat.get(chatId);
  if (!list?.length) return null;
  const earlier = list.filter((e) => e.at < turnStartedAt);
  if (!earlier.length) return null;
  let budget = MAX_CHARS;
  const blocks: string[] = [];
  for (const e of [...earlier].reverse()) {
    if (budget <= 0) break;
    const text = e.text.length > budget ? `${e.text.slice(0, budget)}\n… (cut)` : e.text;
    blocks.unshift(text);
    budget -= text.length;
  }
  for (const e of earlier) e.shown += 1;
  const kept = list.filter((e) => e.shown < TURNS);
  if (kept.length) byChat.set(chatId, kept);
  else byChat.delete(chatId);
  return [
    "Background results you were given in an earlier turn, kept here because they are not in the saved conversation. Use them rather than redoing the work:",
    ...blocks,
  ].join("\n\n");
}

/** Test-only. */
export function __resetDeliveredResults(): void {
  byChat.clear();
}
