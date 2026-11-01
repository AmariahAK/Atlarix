/**
 * How an editor hears that a turn failed. Pure (src/__tests__/acp-turn-error.test.ts).
 */
import { isGateRefusal } from "@/shared/billing_copy";

export interface ErrorMark {
  error: string | null;
  startedAt: number | null;
}

/**
 * The error THIS turn ended with, or null. A turn that started clears the
 * session's error, so any error after it is this turn's, even when it reads
 * exactly like the last one: comparing text alone dropped a second identical
 * refusal, and the editor showed the user's message with nothing under it
 * (QA B3, 2026-10-31). With no turn started, only a new text counts.
 */
export function turnErrorSince(before: ErrorMark, now: ErrorMark): string | null {
  if (!now.error) return null;
  if (now.startedAt !== before.startedAt) return now.error;
  return now.error !== before.error ? now.error : null;
}

/**
 * A billing or gate refusal is the turn's answer, not a protocol error: Zed
 * showed it as "Internal error: …" in a red "An Error Happened" box (QA C2).
 * Atlarix's own panel still takes it as an error, which is what draws its Add
 * credit / Get Pro / own-key buttons.
 */
export function refusalDelivery(error: string, ownPanel: boolean): "reply" | "error" {
  return isGateRefusal(error) && !ownPanel ? "reply" : "error";
}
