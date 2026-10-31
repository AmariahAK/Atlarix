/**
 * WHEN COMPACTION FIRES, and HOW MUCH ROOM each of its steps may protect.
 * Deliberately its own module, and deliberately the OWNER of these numbers.
 *
 * These used to live in `tier_context_budget.ts`, which transitively imports the
 * summarizer, the provider clients and settings/keychain. Nothing about "does this
 * request fit?" needs any of that, and pulling that chain into a test made the run
 * hang past the node project's default timeout — so the numbers that decide
 * whether a long turn survives had no direct coverage. `tier_context_budget`
 * re-exports them, so callers are unchanged.
 *
 * They live HERE rather than in `compaction.ts` for exactly that reason: this is
 * the leaf, so the compactor can import them without their tests having to import
 * the compactor. Everything below is pure arithmetic — the caller resolves the
 * catalog values and passes plain numbers in.
 */

import type { ModelMessage } from "ai";
import { estimateTokens } from "../../ipc/utils/token_utils";

/**
 * A reply may never claim more than this share of the window.
 *
 * Without a clamp the arithmetic inverts: the reasoning output floor is 32,000, so
 * on a 16,000-token budget `window − reserve` is NEGATIVE and every downstream
 * fraction is nonsense. Capping the reserve keeps `usable` at 60% of the window in
 * the worst case, and on any normal window the model's real output limit is well
 * under 40% so this clamp never binds.
 */
export const MAX_RESERVE_FRACTION = 0.4;

/**
 * How much of the context window this request may actually occupy.
 *
 * THE WINDOW HAS TO HOLD THE REPLY TOO. This replaces a flat
 * `COMPACTION_THRESHOLD = 0.9`, which was a crude stand-in for exactly this
 * reserve — and wrong in both directions, because a fixed percentage of a window
 * has no relationship to how long a reply can be:
 *
 *   1,000,000 window → 0.9 reserved 100,000 for output. A reply needs ~32,000.
 *                      We compacted ~68,000 tokens earlier than necessary, every
 *                      time, throwing away detail the model had room to keep.
 *      16,000 window → 0.9 reserved 1,600. A reasoning model wants 32,000 and
 *                      cannot reply at all; we compacted too late AND still did
 *                      not fit.
 *
 * `maxOutputTokens` comes from the models.dev catalog (`getMaxTokensWithFloor`),
 * so this scales per model instead of per guess. Pure arithmetic on purpose: the
 * caller resolves the catalog value, this module stays importable by a test that
 * does not want the provider chain.
 */
export function usableContextBudget(params: {
  contextWindow: number;
  maxOutputTokens: number;
}): number {
  const window = Math.max(0, params.contextWindow);
  if (window === 0) return 0;
  const reserve = Math.min(
    Math.max(0, params.maxOutputTokens),
    Math.floor(window * MAX_RESERVE_FRACTION),
  );
  return Math.max(1, window - reserve);
}

/**
 * Absolute compaction ceiling: compact once the request passes this many tokens,
 * however large the model's window is.
 *
 * `usableContextBudget` alone never fires on a 1M-token model until ~970k, so
 * sessions sat at 350-485k and every step re-sent the whole conversation
 * (2026-10-31 spend incident: the first call of each turn cached ~10.5k of
 * ~440k). This is the owner's knob — raise it to compact less eagerly, lower it
 * to compact sooner. The pre-dispatch gate (context-assembly.ts) compares the
 * request against `min(usable, ceiling)`, so a small window still governs itself.
 */
export const ABSOLUTE_COMPACTION_CEILING = 200_000;

/** The trigger threshold: whichever comes first, the usable budget or the ceiling. */
export function compactionCeiling(usableTokens: number): number {
  return Math.min(usableTokens, ABSOLUTE_COMPACTION_CEILING);
}

/** Whether the request must be compacted before dispatch, given its size. */
export function compactionShouldTrigger(opts: {
  dispatchEstimate: number;
  usableTokens: number;
}): boolean {
  return opts.dispatchEstimate > compactionCeiling(opts.usableTokens);
}

/**
 * Every limit compaction's steps compare against, derived from the budget they
 * are protecting space within.
 *
 * WHY THIS EXISTS. Each of these was an absolute constant tuned for a large
 * window, and on a small one each step silently opted itself out. Measured
 * 2026-08-31 on a real 4-message session of ~41,000 tokens against a 16,000-token
 * cap, where NOTHING compacted:
 *
 *   microcompact   keep last 3 TURNS      the session had 2 → no-op
 *   prune          PRUNE_MINIMUM 20,000   protected more than the whole budget,
 *                                         so a 19,000-token message was kept whole
 *   summarise      count precondition     arithmetically impossible at 4 messages
 *
 * THE INVARIANT: no protection floor may exceed the budget it protects within.
 * All of the above violated it. `assertBudgetsFitWithin` below encodes it, and a
 * test drives it across window sizes from 8K to 1M.
 */
export interface CompactionBudgets {
  /** Recent tool output kept verbatim by the pruner (was PRUNE_MINIMUM_TOKENS). */
  pruneProtectRecent: number;
  /** Below this much history, a forced compaction is an honest no-op. */
  forceMinHistory: number;
  /** Recent conversation kept verbatim by the summariser's tail selection. */
  preserveRecent: number;
  /** Tool-output budget in the head handed to the summariser. */
  headToolTokens: number;
  /** Recent tool output microcompact leaves alone (was a count of turns). */
  microcompactKeepTokens: number;
}

export function compactionBudgets(usable: number): CompactionBudgets {
  const u = Math.max(1, usable);
  const share = (fraction: number, min: number) =>
    Math.max(Math.min(min, u), Math.floor(u * fraction));
  return {
    // The pruner protects the newest tool output; a quarter leaves three quarters
    // reclaimable, which is what makes a tool-heavy turn compressible at all.
    pruneProtectRecent: share(0.25, 1_000),
    // Summarising a history smaller than this cannot free enough to be worth a
    // provider call.
    forceMinHistory: share(0.5, 1_000),
    preserveRecent: share(0.25, 1_000),
    headToolTokens: share(0.5, 2_000),
    microcompactKeepTokens: share(0.35, 1_000),
  };
}

/** The invariant, callable so a test can assert it rather than restate it. */
export function assertBudgetsFitWithin(
  budgets: CompactionBudgets,
  usable: number,
): string[] {
  return Object.entries(budgets)
    .filter(([, v]) => v > usable)
    .map(([k, v]) => `${k}=${v} exceeds usable=${usable}`);
}

/** Text of a ModelMessage for estimation — tool results included, media ignored. */
export function modelMessageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (!part || typeof part !== "object") return "";
        const p = part as {
          type?: string;
          text?: string;
          output?: unknown;
          result?: unknown;
        };
        if (p.type === "text" && typeof p.text === "string") return p.text;
        if (p.type === "tool-result") {
          const v = p.output ?? p.result;
          return typeof v === "string" ? v : v == null ? "" : JSON.stringify(v);
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

/**
 * Whether compaction would fire for this history.
 *
 * Compares against `usable` — the window MINUS the room the reply needs — rather
 * than a fraction of the raw window. `usable` already accounts for the model's
 * real output limit, so there is no second ratio to tune here and no way for the
 * two to drift apart.
 *
 * `usableTokens` is optional only so a caller that has not resolved the catalog
 * can still ask; it falls back to the per-dispatch tier limit, which is the
 * window in the normal case (`overflowClampFor` defaults to 1).
 */
export function compactionWouldTrigger(params: {
  messages: ModelMessage[];
  systemPromptEstimate: number;
  tierLimit: number;
  usableTokens?: number;
}): { willTrigger: boolean; beforeTokens: number; usable: number } {
  const usable = params.usableTokens ?? params.tierLimit;
  const beforeTokens =
    params.messages.reduce(
      (acc, m) => acc + estimateTokens(modelMessageText(m.content)),
      0,
    ) + params.systemPromptEstimate;
  return { willTrigger: beforeTokens > usable, beforeTokens, usable };
}

/** @deprecated Name kept for existing callers; `compactionWouldTrigger` is the same check. */
export const midLoopCompactionWouldTrigger = compactionWouldTrigger;
