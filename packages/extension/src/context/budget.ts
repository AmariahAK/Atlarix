/**
 * How full the context is, when compaction fires, and how much room each of its
 * steps may protect.
 *
 * A PORT of the desktop's `src/lib/context/mid-loop-threshold.ts` and
 * `context-budget-tracker.ts`, with the one Node-bound import severed. The
 * desktop's `estimateTokens` lives in `ipc/utils/token_utils`, which pulls in
 * `main/settings` — unreachable here and unnecessary, because the numbers below
 * are pure arithmetic on a token count and do not care where it came from.
 *
 * NO WASM TOKENIZER, deliberately. `@anthropic-ai/tokenizer` is CJS + WASM and
 * would need `wasm-unsafe-eval` in the extension CSP — a relaxation this package
 * has refused throughout, and one a Web Store reviewer reads as "this extension
 * can execute generated code". So the estimate is `len / 4`, which is already
 * what the desktop's own `token-counter.ts` falls back to when the tokenizer
 * throws. It runs ±20% on English prose and worse on dense JSON.
 *
 * THE 40% REPLY RESERVE IS WHAT MAKES THAT SAFE. `usableContextBudget` hands the
 * model's whole output allowance back before anything is measured against the
 * window, so a 20% under-count eats into a reserve rather than into the request.
 * An estimator this rough would be reckless against a raw window and is fine
 * against this one.
 */

import type { CoreMessage } from "../core/client";

/**
 * The fallback ratio, for a model nothing has been measured for yet.
 *
 * THE REAL RATIO IS LEARNED — see `calibration.ts`. Every streamed turn ends
 * with the provider's own `prompt_tokens`, which is exact, and the ratio for
 * that model is folded toward what was actually charged. Four characters to a
 * token is where a model STARTS, not where it stays.
 */
export const DEFAULT_CHARS_PER_TOKEN = 4;

export function estimateTokens(
  text: string,
  charsPerToken: number = DEFAULT_CHARS_PER_TOKEN,
): number {
  const ratio = charsPerToken > 0 ? charsPerToken : DEFAULT_CHARS_PER_TOKEN;
  return Math.ceil(text.length / ratio);
}

/**
 * A reply may never claim more than this share of the window.
 *
 * Without a clamp the arithmetic inverts: a reasoning model's output floor is
 * 32,000, so on a 16,000-token window `window − reserve` is NEGATIVE and every
 * fraction downstream is nonsense. Capping it keeps `usable` at 60% of the
 * window in the worst case; on any normal window the model's real output limit
 * is well under 40% and this never binds.
 */
export const MAX_RESERVE_FRACTION = 0.4;

/**
 * How much of the context window this conversation may actually occupy.
 *
 * THE WINDOW HAS TO HOLD THE REPLY TOO. A flat "compact at 90%" is wrong in both
 * directions, because a fixed percentage of a window has no relationship to how
 * long a reply can be: on a 1M window it reserves 100,000 tokens for a reply
 * that needs 32,000 and throws away detail there was room to keep; on a 16,000
 * window it reserves 1,600 for a model that wants 32,000 and still does not fit.
 *
 * Both inputs come from the PROXY's `/v1/models` (`context_window`,
 * `max_output_tokens`), which reads them from the same models.dev catalog the
 * proxy already bills from. Nothing here restates a config.
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
 * Every limit compaction's steps compare against, derived from the budget they
 * are protecting space within.
 *
 * WHY THESE ARE FRACTIONS AND NOT CONSTANTS. Each was an absolute number tuned
 * for a large window, and on a small one each step silently opted itself out.
 * Measured on the desktop, 2026-08-31, on a ~41,000-token session against a
 * 16,000-token cap where NOTHING compacted: microcompact kept the last 3 turns
 * and the session had 2; the pruner's 20,000-token floor protected more than the
 * entire budget, so a 19,000-token message was kept whole; the summariser's
 * message-count precondition was arithmetically unreachable at 4 messages.
 *
 * THE INVARIANT: no protection floor may exceed the budget it protects within.
 * All three violated it. `assertBudgetsFitWithin` encodes it so a test can drive
 * it across window sizes rather than restate the numbers.
 */
export interface CompactionBudgets {
  /** Recent tool output the pruner keeps verbatim. */
  pruneProtectRecent: number;
  /** Below this much history, compacting is an honest no-op. */
  forceMinHistory: number;
  /** Recent conversation the summariser's tail selection keeps verbatim. */
  preserveRecent: number;
  /** Tool-output budget in the head handed to the summariser. */
  headToolTokens: number;
  /** Recent tool output microcompact leaves alone. */
  microcompactKeepTokens: number;
}

export function compactionBudgets(usable: number): CompactionBudgets {
  const u = Math.max(1, usable);
  const share = (fraction: number, min: number) =>
    Math.max(Math.min(min, u), Math.floor(u * fraction));
  return {
    // A quarter protected leaves three quarters reclaimable, which is what makes
    // a tool-heavy turn compressible at all.
    pruneProtectRecent: share(0.25, 1_000),
    forceMinHistory: share(0.5, 1_000),
    preserveRecent: share(0.25, 1_000),
    headToolTokens: share(0.5, 2_000),
    microcompactKeepTokens: share(0.35, 1_000),
  };
}

/** The invariant, callable so a test asserts it rather than restating it. */
export function assertBudgetsFitWithin(
  budgets: CompactionBudgets,
  usable: number,
): string[] {
  return Object.entries(budgets)
    .filter(([, v]) => v > usable)
    .map(([k, v]) => `${k}=${v} exceeds usable=${usable}`);
}

/**
 * The text of one message, for estimation.
 *
 * TOOL CALL ARGUMENTS COUNT. An assistant message whose `content` is null but
 * which carries four tool calls is not free — the arguments are JSON the model
 * is billed for, and a read of a long page can carry a long selector. Counting
 * only `content` would make a tool-heavy conversation look half its real size,
 * which is exactly the conversation that needs compacting.
 */
export function messageText(message: CoreMessage): string {
  const parts: string[] = [];
  if (typeof message.content === "string") parts.push(message.content);
  if (message.role === "assistant") {
    for (const call of message.tool_calls ?? []) {
      parts.push(call.function.name, call.function.arguments);
    }
  }
  return parts.join("\n");
}

/** Estimated tokens for a whole transcript. */
export function estimateMessages(
  messages: CoreMessage[],
  charsPerToken: number = DEFAULT_CHARS_PER_TOKEN,
): number {
  return messages.reduce(
    (n, m) => n + estimateTokens(messageText(m), charsPerToken),
    0,
  );
}

/** Total characters of a transcript, for calibrating against a usage frame. */
export function messagesChars(messages: CoreMessage[]): number {
  return messages.reduce((n, m) => n + messageText(m).length, 0);
}

/**
 * Whether compaction would fire for this history.
 *
 * Compares against `usable` — the window MINUS the room the reply needs —
 * rather than a fraction of the raw window. `usable` already accounts for the
 * model's real output limit, so there is no second ratio to tune and no way for
 * the two to drift apart.
 */
export function compactionWouldTrigger(params: {
  messages: CoreMessage[];
  overheadTokens: number;
  usable: number;
  charsPerToken?: number;
}): { willTrigger: boolean; beforeTokens: number; usable: number } {
  const beforeTokens =
    estimateMessages(params.messages, params.charsPerToken) +
    Math.max(0, params.overheadTokens);
  return {
    willTrigger: beforeTokens > params.usable,
    beforeTokens,
    usable: params.usable,
  };
}

/**
 * How full the context is, as something the UI can colour.
 *
 * The desktop's `ContextBudgetTracker` thresholds, as a function rather than a
 * class — there is no state here, and the class's other seven methods were all
 * `getBudgetTier() === x`.
 */
export type ContextBudgetHealth = "healthy" | "warning" | "critical" | "over";

export function budgetHealth(ratio: number): ContextBudgetHealth {
  if (ratio < 0.5) return "healthy";
  if (ratio < 0.7) return "warning";
  if (ratio < 0.85) return "critical";
  return "over";
}

/** Everything the bar above the composer needs, from one measurement. */
export interface ContextStatus {
  usedTokens: number;
  usable: number;
  ratio: number;
  health: ContextBudgetHealth;
  /**
   * The count came from the provider rather than from arithmetic.
   *
   * True only when a usage frame covers the transcript exactly — nothing has
   * been added since it was measured. The bar does not say so out loud, but the
   * compactor uses it: a measured overflow is a fact, and an estimated one is a
   * prediction.
   */
  exact: boolean;
  /** True once the next round would exceed `usable`. */
  willCompact: boolean;
}

/**
 * Measure a conversation against the tier it is running on.
 *
 * `contextWindow` of 0 means the proxy had no catalog row. That is UNKNOWN, not
 * empty, and the caller must hide the bar rather than draw a full one — a bar
 * pinned at 100% on a fresh conversation is a bug report waiting to happen.
 */
export function measureContext(params: {
  messages: CoreMessage[];
  overheadTokens: number;
  contextWindow: number;
  maxOutputTokens: number;
  charsPerToken?: number;
  anchor?: UsageAnchor | null;
}): ContextStatus | null {
  const usable = usableContextBudget({
    contextWindow: params.contextWindow,
    maxOutputTokens: params.maxOutputTokens,
  });
  if (usable <= 0) return null;
  const { usedTokens, exact } = usedTokensFor(params);
  const ratio = usedTokens / usable;
  return {
    usedTokens,
    usable,
    ratio,
    exact,
    health: budgetHealth(ratio),
    willCompact: usedTokens > usable,
  };
}

/**
 * The exact size of a request the provider has already counted.
 *
 * `promptTokens` covers the WHOLE request — system prompt, tool schemas and
 * transcript — so an anchored measurement must not add the overhead again.
 * `messageCount` is how many messages were in the transcript at the time, which
 * is what makes "everything since" identifiable.
 */
export interface UsageAnchor {
  promptTokens: number;
  messageCount: number;
}

/**
 * How many tokens the conversation is, using the measured number where there is
 * one.
 *
 * A MEASURED BASE PLUS A SMALL ESTIMATE, rather than an estimate of everything.
 * After any turn the provider has told us exactly what the conversation cost as
 * sent; only the messages added since then are unknown. So the error is bounded
 * by the size of one turn instead of by the size of the conversation, and it
 * RESETS to zero every time a turn completes rather than compounding.
 *
 * The anchor is abandoned if the transcript got SHORTER than it was — compaction
 * rewrote it, or the user edited and rewound — because the messages the anchor
 * counted are no longer the messages that are there.
 */
export function usedTokensFor(params: {
  messages: CoreMessage[];
  overheadTokens: number;
  charsPerToken?: number;
  anchor?: UsageAnchor | null;
}): { usedTokens: number; exact: boolean } {
  const anchor = params.anchor;
  if (anchor && anchor.promptTokens > 0 && params.messages.length >= anchor.messageCount) {
    const since = params.messages.slice(anchor.messageCount);
    return {
      usedTokens:
        anchor.promptTokens + estimateMessages(since, params.charsPerToken),
      exact: since.length === 0,
    };
  }
  return {
    usedTokens:
      estimateMessages(params.messages, params.charsPerToken) +
      Math.max(0, params.overheadTokens),
    exact: false,
  };
}
