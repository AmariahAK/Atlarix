/**
 * Mid-turn plan-ledger refresh.
 *
 * The compact `[Session plan] N/M steps done` ledger is built once during context
 * assembly and injected at step 0 of a turn (`simple-stream-text.ts`). That is
 * fine for a short turn, but a long agentic turn runs dozens of steps and the
 * model marks steps done throughout it — so for the rest of that turn the ledger
 * in context keeps asserting the turn-START counts.
 *
 * Observed failure: an agent completed 25 of 31 steps inside one turn while the
 * ledger kept repeating "2/31 steps done" and listing all 29 as remaining. Handed
 * that contradiction, the agent concluded its own tooling was broken, rewrote the
 * whole plan, re-marked every step, and looped — burning the turn arguing with a
 * stale snapshot instead of working.
 *
 * Fix: whenever the plan tool mutates a plan it formats a fresh ledger here,
 * keyed by chat. `prepareStep` is synchronous, so the block is pre-rendered at
 * mutation time (the mutating call already holds the updated content) rather than
 * re-read from the DB at injection time.
 *
 * WHY THE LATEST BLOCK IS STICKY AND NOT TAKE-ONCE
 * -----------------------------------------------
 * It used to be a plain take-once queue, which fixed later STEPS but not later
 * ROUNDS. `run-agent-turn` re-enters the stream once per agentic round (gate
 * nudge, stall resume, stream continuation), and each round starts a fresh
 * `streamText`, so `stepNumber` returns to 0 — where the injection
 * unconditionally used the frozen turn-start block. A drained queue had nothing
 * left to override it with.
 *
 * Observed 2026-08-19: a turn that began with 1 of 6 steps done marked steps 1-3
 * done, hit the completion gate, and was handed "[Session plan] 1/6 steps done"
 * again on the next round. The model read that as the plan having been reset,
 * abandoned `update_step`, and rewrote the whole plan to force agreement — the
 * exact loop this module exists to prevent, arriving through the round boundary
 * instead of the step boundary. (It is easy to misread the neighbouring log line
 * `Plan not complete — nudge 1/6` as the same number; that one is the nudge
 * budget, and the two are unrelated.)
 *
 * So the newest rendered block is kept until the end of the turn and served at
 * every round boundary, while the take-once flag still governs mid-round steps so
 * an unchanged ledger is not repeated on every step.
 *
 * The stickiness is TURN-scoped: `clearPlanLedgerRefresh` is called from chat
 * stream preflight, which runs exactly once per turn, immediately before the
 * turn-start block is computed. Without that call a block rendered in one turn
 * would outrank the freshly-read snapshot of the next one.
 */

import {
  extractPlanChecklistTitle,
  formatPlanChecklistForPrompt,
  parsePlanChecklist,
} from "./plan-checklist";

/** Newest rendered ledger for the chat's current turn. */
const latestByChat = new Map<number, string>();
/** Chats whose latest block has not been injected since it last changed. */
const dirtyChats = new Set<number>();

/**
 * Re-render the ledger for `chatId` from freshly-written plan content. Later
 * calls overwrite earlier ones — only the newest state matters, and collapsing
 * them keeps a burst of `update_step` calls from queueing several near-identical
 * blocks.
 */
export function markPlanLedgerDirty(
  chatId: number | null | undefined,
  content: string,
): void {
  if (chatId == null) return;
  try {
    const block = formatPlanChecklistForPrompt(
      parsePlanChecklist(content),
      extractPlanChecklistTitle(content),
    );
    if (block) {
      latestByChat.set(chatId, block);
      dirtyChats.add(chatId);
    }
  } catch {
    // Never let ledger bookkeeping break a plan mutation.
  }
}

/**
 * Mid-round drain. Returns null when the plan hasn't changed since the last
 * injection, so an unchanged ledger is not restated on every step of a long
 * round.
 */
export function takeRefreshedPlanLedger(
  chatId: number | null | undefined,
): string | null {
  if (chatId == null) return null;
  if (!dirtyChats.delete(chatId)) return null;
  return latestByChat.get(chatId) ?? null;
}

/**
 * The freshest ledger known for this turn, regardless of whether it has already
 * been injected — for the places that would otherwise fall back to the frozen
 * turn-start block: step 0 of every agentic round, and the stall-resume /
 * stream-continuation prompts. Returns null when the plan has not been mutated
 * this turn, and the caller keeps its turn-start block.
 *
 * Clears the dirty flag, since serving it here is an injection like any other.
 */
export function currentPlanLedger(
  chatId: number | null | undefined,
): string | null {
  if (chatId == null) return null;
  const block = latestByChat.get(chatId);
  if (!block) return null;
  dirtyChats.delete(chatId);
  return block;
}

/**
 * Drop this chat's ledger state. Called from stream preflight so the stickiness
 * above cannot leak from one turn into the next, and on a finished/cancelled
 * chat.
 */
export function clearPlanLedgerRefresh(chatId: number): void {
  latestByChat.delete(chatId);
  dirtyChats.delete(chatId);
}
