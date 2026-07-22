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
 * re-read from the DB at injection time. Take-once, exactly like the background
 * result / stall advisory queues it rides alongside.
 */

import {
  extractPlanChecklistTitle,
  formatPlanChecklistForPrompt,
  parsePlanChecklist,
} from "./plan-checklist";

const pendingByChat = new Map<number, string>();

/**
 * Re-render the ledger for `chatId` from freshly-written plan content. Later
 * calls within the same step overwrite earlier ones — only the newest state
 * matters, and collapsing them keeps a burst of `update_step` calls from
 * queueing several near-identical blocks.
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
    if (block) pendingByChat.set(chatId, block);
  } catch {
    // Never let ledger bookkeeping break a plan mutation.
  }
}

/** Take-once drain. Returns null when the plan hasn't changed since last inject. */
export function takeRefreshedPlanLedger(
  chatId: number | null | undefined,
): string | null {
  if (chatId == null) return null;
  const block = pendingByChat.get(chatId);
  if (!block) return null;
  pendingByChat.delete(chatId);
  return block;
}

/** Drop queued state for a finished/cancelled chat. */
export function clearPlanLedgerRefresh(chatId: number): void {
  pendingByChat.delete(chatId);
}
