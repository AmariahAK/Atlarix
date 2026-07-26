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
  tokens: number;
  calls: number;
  /** Split is 0 when the provider reported only a total. */
  inputTokens: number;
  outputTokens: number;
};

export type AuxUsageTotals = {
  totalTokens: number;
  calls: number;
  /** Per-source subtotals (e.g. "subagent:task", "compaction"). */
  byLabel: Record<string, AuxLabelTotals>;
};

const buckets = new Map<number, AuxUsageTotals>();

function emptyTotals(): AuxUsageTotals {
  return { totalTokens: 0, calls: 0, byLabel: {} };
}

export function resetAuxUsage(chatId: number): void {
  buckets.set(chatId, emptyTotals());
}

/**
 * Record one auxiliary LLM call's usage. Safe to call with anything —
 * unknown shapes and missing chat ids are ignored.
 */
export function recordAuxUsage(
  chatId: number | null | undefined,
  usage: unknown,
  label: string,
): number | null {
  if (chatId == null) return null;
  const tokens = totalTokensFromAiUsage(usage as LooseAiUsage | undefined);
  if (tokens == null || tokens <= 0) return null;
  let bucket = buckets.get(chatId);
  if (!bucket) {
    bucket = emptyTotals();
    buckets.set(chatId, bucket);
  }
  bucket.totalTokens += tokens;
  bucket.calls += 1;

  const entry = (bucket.byLabel[label] ??= {
    tokens: 0,
    calls: 0,
    inputTokens: 0,
    outputTokens: 0,
  });
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

/** Drain the bucket at stream end (returns null when nothing was recorded). */
export function takeAuxUsage(chatId: number | null | undefined): AuxUsageTotals | null {
  if (chatId == null) return null;
  const bucket = buckets.get(chatId);
  buckets.delete(chatId);
  return bucket && bucket.totalTokens > 0 ? bucket : null;
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
): Array<{ source: "subagents" | "compaction" | "other"; tokens: number; calls: number }> {
  if (!totals) return [];
  const grouped = new Map<"subagents" | "compaction" | "other", { tokens: number; calls: number }>();
  for (const [label, entry] of Object.entries(totals.byLabel)) {
    const source = label.startsWith("subagent")
      ? "subagents"
      : label.startsWith("compaction")
        ? "compaction"
        : "other";
    const bucket = grouped.get(source) ?? { tokens: 0, calls: 0 };
    bucket.tokens += entry.tokens;
    bucket.calls += entry.calls;
    grouped.set(source, bucket);
  }
  return [...grouped.entries()]
    .map(([source, v]) => ({ source, ...v }))
    .sort((a, b) => b.tokens - a.tokens);
}
