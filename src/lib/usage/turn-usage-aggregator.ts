/**
 * Auxiliary LLM usage aggregator (v10 token accuracy)
 * ===================================================
 * Sub-agent delegations, mid-loop compaction, and other auxiliary
 * `generateText` calls burn tokens that the parent stream's `onFinish`
 * never sees. Each stream resets its chat bucket at start; auxiliary
 * call sites record into it; the stream drains it at the end and folds
 * the total into the turn's usage report.
 *
 * Usage is kept PER SOURCE LABEL, with the input/output split, not just a running
 * total. Two reasons: the UI previously showed one lumped figure labelled
 * "Sub-agents" that also included compaction, and an input/output split is what any
 * cost attribution needs (input and output rates differ by 2-5x).
 */

import log from "electron-log";
import { totalTokensFromAiUsage, type LooseAiUsage } from "@/lib/usage/ai-usage";
import { inputOutputTokensFromUsage } from "@/lib/routing/byok-pricing";

const logger = log.scope("turn-usage");

export type AuxLabelTotals = {
  /** Tokens the PROVIDER reported. Never inferred. */
  tokens: number;
  calls: number;
  /** Split is 0 when the provider reported only a total. */
  inputTokens: number;
  outputTokens: number;
  /**
   * Tokens ESTIMATED for calls the provider reported nothing for, kept apart from
   * `tokens` so a consumer can always tell a measured figure from an inferred one.
   *
   * Same discipline as the input/output split above, and for a sharper reason: this
   * repo has already been burned trusting an estimate. One session measured 417K by
   * the provider against 211K estimated — roughly 2× — which is why
   * `session_messages.maxTokensUsed` exists at all. An estimate presented as spend
   * is a worse failure than the under-report it replaces, so it travels labelled or
   * not at all.
   */
  estimatedTokens: number;
};

export type AuxUsageTotals = {
  /** Provider-reported total. */
  totalTokens: number;
  calls: number;
  /** Estimated total, for calls whose provider returned no usage. */
  totalEstimatedTokens: number;
  /** Per-source subtotals (e.g. "subagent:task", "compaction"). */
  byLabel: Record<string, AuxLabelTotals>;
};

const buckets = new Map<number, AuxUsageTotals>();

function emptyTotals(): AuxUsageTotals {
  return { totalTokens: 0, calls: 0, totalEstimatedTokens: 0, byLabel: {} };
}

export function resetAuxUsage(chatId: number): void {
  buckets.set(chatId, emptyTotals());
}

/**
 * Record one auxiliary LLM call's usage. Safe to call with anything —
 * unknown shapes and missing chat ids are ignored.
 *
 * WHEN THE PROVIDER REPORTS NOTHING. This used to `return null` on missing usage,
 * which dropped the whole call: not just its tokens but the fact that it happened.
 * Observed 2026-08-31 — a turn ran four sub-agents, one of them eight steps deep,
 * and reported `across 1 call(s)`. The run whose provider returned no usage
 * vanished entirely from the total the user is shown. Free OpenRouter routes
 * commonly omit usage, and those are exactly the routes someone watching their
 * spend is on.
 *
 * A caller that can estimate the call's size passes `fallbackTokens`. That lands in
 * `estimatedTokens`, SEPARATE from provider-reported `tokens`, and `calls` still
 * increments — so the count is right even when the size is only inferred. A
 * provider figure always wins; a fallback never overwrites one.
 */
export function recordAuxUsage(
  chatId: number | null | undefined,
  usage: unknown,
  label: string,
  opts?: {
    /**
     * LAZY on purpose. Estimating means running an exact tokenizer over the whole
     * request, which on a sub-agent's tool-heavy history is not free — and it is
     * wasted entirely on the common path where the provider did report usage. The
     * thunk is called only when there is no measured figure to use.
     */
    estimateTokens?: () => number;
  },
): number | null {
  if (chatId == null) return null;
  const tokens = totalTokensFromAiUsage(usage as LooseAiUsage | undefined);
  const measured = tokens != null && tokens > 0;
  const fallback = measured
    ? 0
    : Math.max(0, Math.floor(opts?.estimateTokens?.() ?? 0));
  // Nothing measured and nothing to estimate from: unchanged from before, so we
  // never invent a zero-token entry that looks like a real one.
  if (!measured && fallback <= 0) return null;

  let bucket = buckets.get(chatId);
  if (!bucket) {
    bucket = emptyTotals();
    buckets.set(chatId, bucket);
  }
  const entry = (bucket.byLabel[label] ??= {
    tokens: 0,
    calls: 0,
    inputTokens: 0,
    outputTokens: 0,
    estimatedTokens: 0,
  });

  if (!measured) {
    bucket.totalEstimatedTokens += fallback;
    bucket.calls += 1;
    entry.estimatedTokens += fallback;
    entry.calls += 1;
    // INFO, not debug: a provider that never reports usage should be visible.
    logger.info(
      `aux usage ~${fallback} ESTIMATED (${label}) chat ${chatId} — provider reported none`,
    );
    return fallback;
  }

  bucket.totalTokens += tokens;
  bucket.calls += 1;
  entry.tokens += tokens;
  entry.calls += 1;
  // Absent when the provider reported only a total — recorded as 0 rather than
  // guessed, so a consumer can tell "no split available" from "zero output".
  const split = inputOutputTokensFromUsage(usage);
  if (split) {
    entry.inputTokens += split.inputTokens;
    entry.outputTokens += split.outputTokens;
  }

  logger.debug(`aux usage +${tokens} (${label}) chat ${chatId} → ${bucket.totalTokens}`);
  return tokens;
}

/**
 * Drain the bucket at stream end (returns null when nothing was recorded).
 *
 * `totalEstimatedTokens` counts toward "something was recorded": a turn whose only
 * auxiliary calls came from a provider that reports no usage still spent money, and
 * gating on `totalTokens` alone is what made those turns look empty.
 */
export function takeAuxUsage(chatId: number | null | undefined): AuxUsageTotals | null {
  if (chatId == null) return null;
  const bucket = buckets.get(chatId);
  buckets.delete(chatId);
  if (!bucket) return null;
  const recorded = bucket.totalTokens > 0 || bucket.totalEstimatedTokens > 0;
  return recorded ? bucket : null;
}

/**
 * Group the raw labels into the sources worth showing a user.
 *
 * `subagent:*` is one bucket however many delegations ran; compaction is its own,
 * because it is the app spending tokens on the user's behalf rather than work they
 * asked for — conflating the two (as the old single "Sub-agents" line did) hides
 * exactly the thing someone auditing their spend wants to see.
 */
export function summarizeAuxBySource(
  totals: AuxUsageTotals | null,
): Array<{
  source: "subagents" | "compaction" | "other";
  tokens: number;
  calls: number;
  /** Of `tokens`, how much is estimated rather than provider-reported. */
  estimatedTokens: number;
}> {
  if (!totals) return [];
  const grouped = new Map<
    "subagents" | "compaction" | "other",
    { tokens: number; calls: number; estimatedTokens: number }
  >();
  for (const [label, entry] of Object.entries(totals.byLabel)) {
    const source = label.startsWith("subagent")
      ? "subagents"
      : label.startsWith("compaction")
        ? "compaction"
        : "other";
    const bucket = grouped.get(source) ?? { tokens: 0, calls: 0, estimatedTokens: 0 };
    // `tokens` is the best total available — measured plus estimated — while
    // `estimatedTokens` says how much of it to trust less. A caller that wants only
    // measured spend subtracts; one that wants the honest size does not have to
    // know the difference exists.
    bucket.tokens += entry.tokens + entry.estimatedTokens;
    bucket.estimatedTokens += entry.estimatedTokens;
    bucket.calls += entry.calls;
    grouped.set(source, bucket);
  }
  return [...grouped.entries()]
    .map(([source, v]) => ({ source, ...v }))
    .sort((a, b) => b.tokens - a.tokens);
}
