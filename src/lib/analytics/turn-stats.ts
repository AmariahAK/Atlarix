/**
 * What happened during one turn, counted where it happens and read once when
 * the turn ends (`turn_completed`). Keyed by chat, in memory only: the code
 * that asks for approval, compacts, spawns a sub-agent or retries a stream
 * sits several calls below the turn and has the chat id, not the turn's state.
 *
 * Counting costs a map lookup. Nothing here is sent anywhere; the turn's one
 * event carries the totals, and only for people who opted in.
 */

export type TurnCounter =
  | "approvals_asked"
  | "approvals_auto"
  | "approvals_denied"
  | "compactions"
  | "subagents"
  | "retries";

export type TurnCounts = Record<TurnCounter, number>;

/** The loop's own totals, known only when it ran to an end. */
export interface TurnLoopTotals {
  iterations: number;
  tool_count: number;
}

/** A request error the stream reported, as classified (turn-end.ts). */
export interface TurnStreamError {
  kind: string;
  httpStatus?: number;
}

/** Who paid for an Atlarix Auto reply, as the proxy said (`x-atlarix-billing`). */
export type AutoBilling = "free" | "paid";

const counts = new Map<number, TurnCounts>();
const loopTotals = new Map<number, TurnLoopTotals>();
const streamErrors = new Map<number, TurnStreamError>();
const autoBilling = new Map<number, AutoBilling>();

function empty(): TurnCounts {
  return {
    approvals_asked: 0,
    approvals_auto: 0,
    approvals_denied: 0,
    compactions: 0,
    subagents: 0,
    retries: 0,
  };
}

/** Count one thing that happened in this chat's turn. Never throws. */
export function noteTurn(chatId: number | undefined, key: TurnCounter, by = 1): void {
  if (typeof chatId !== "number") return;
  let c = counts.get(chatId);
  if (!c) {
    c = empty();
    counts.set(chatId, c);
  }
  c[key] += by;
}

export function noteTurnLoopTotals(chatId: number | undefined, totals: TurnLoopTotals): void {
  if (typeof chatId !== "number") return;
  loopTotals.set(chatId, totals);
}

/**
 * The last request error the stream itself reported. The SDK replaces it with
 * a bare "no output generated" before the turn sees anything, so this is the
 * only place its status survives.
 */
export function noteTurnStreamError(chatId: number | undefined, err: TurnStreamError): void {
  if (typeof chatId !== "number") return;
  streamErrors.set(chatId, err);
}

/**
 * Free or paid, from this chat's own Auto reply. The process-wide latest Auto
 * status is shared by every chat, so two turns at once would mix it up.
 */
export function noteTurnAutoBilling(chatId: number | undefined, billing: AutoBilling | null | undefined): void {
  if (typeof chatId !== "number" || !billing) return;
  autoBilling.set(chatId, billing);
}

/**
 * The counts since the chat's last turn ended, and forget them. A manual
 * /compact between turns therefore lands on the next turn.
 */
export function drainTurnStats(chatId: number): {
  counts: TurnCounts;
  loop?: TurnLoopTotals;
  streamError?: TurnStreamError;
  autoBilling?: AutoBilling;
} {
  const c = counts.get(chatId) ?? empty();
  const loop = loopTotals.get(chatId);
  const streamError = streamErrors.get(chatId);
  const auto = autoBilling.get(chatId);
  counts.delete(chatId);
  loopTotals.delete(chatId);
  streamErrors.delete(chatId);
  autoBilling.delete(chatId);
  return {
    counts: c,
    ...(loop ? { loop } : {}),
    ...(streamError ? { streamError } : {}),
    ...(auto ? { autoBilling: auto } : {}),
  };
}
