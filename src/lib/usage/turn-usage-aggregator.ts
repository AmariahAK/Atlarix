/**
 * Auxiliary LLM usage aggregator (v10 token accuracy)
 * ===================================================
 * Sub-agent delegations, mid-loop compaction, and other auxiliary
 * `generateText` calls burn tokens that the parent stream's `onFinish`
 * never sees. Each stream resets its chat bucket at start; auxiliary
 * call sites record into it; the stream drains it at the end and folds
 * the total into Compass metering + the turn's usage report.
 */

import log from "electron-log";
import { totalTokensFromAiUsage, type LooseAiUsage } from "@/lib/auth/compass_usage";

const logger = log.scope("turn-usage");

export type AuxUsageTotals = {
  totalTokens: number;
  calls: number;
  /** Token subtotals per source label (e.g. "delegation:builder", "compaction"). */
  byLabel: Record<string, number>;
};

const buckets = new Map<number, AuxUsageTotals>();

export function resetAuxUsage(chatId: number): void {
  buckets.set(chatId, { totalTokens: 0, calls: 0, byLabel: {} });
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
    bucket = { totalTokens: 0, calls: 0, byLabel: {} };
    buckets.set(chatId, bucket);
  }
  bucket.totalTokens += tokens;
  bucket.calls += 1;
  bucket.byLabel[label] = (bucket.byLabel[label] ?? 0) + tokens;
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
