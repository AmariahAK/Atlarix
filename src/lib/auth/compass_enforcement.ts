/**
 * Strict mid-task token enforcement for Atlarix Core streams.
 *
 * The Supabase RPC (`record_compass_usage`) is the authority — it enforces the
 * monthly limit server-side and handles concurrent devices + the 30-day reset.
 * The local running tally is a fast secondary guard so a turn stops on the same
 * step that crosses the line without waiting for another round-trip.
 *
 * Network/RPC errors never hard-stop a turn (we don't punish users for flaky
 * connectivity); only an authoritative `limit_exceeded` or the local tally
 * crossing the pre-flight budget does.
 */

import type { RecordCompassResult } from "./compass_usage";

export type CompassStreamBudget = {
  /** Tokens left this month at stream start (`monthly_limit - tokens_used`); null when pre-flight failed. */
  remainingBudget: number | null;
  /** Tokens recorded by this stream so far (all steps, including aux turns). */
  usedThisTurn: number;
};

/** Abort reason used when a Core stream is stopped because the token pool ran out. */
export const COMPASS_LIMIT_STREAM_STOP = "compass-token-limit-reached";

export function shouldStopForCompassLimit(
  budget: CompassStreamBudget,
  recordResult: RecordCompassResult | null,
): boolean {
  if (recordResult && !recordResult.ok && recordResult.error === "limit_exceeded") {
    return true;
  }
  if (
    budget.remainingBudget != null &&
    budget.remainingBudget >= 0 &&
    budget.usedThisTurn >= budget.remainingBudget
  ) {
    return true;
  }
  return false;
}
