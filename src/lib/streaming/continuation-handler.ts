/**
 * Stream follow-ups for streamText / generateText.
 * We continue on "length" truncation and on "unknown", which some providers emit
 * after a successful tool call when the next assistant step still needs to run.
 */

import { systemReminder } from "./system-reminder";

export interface ContinuationContext {
  chatId: number;
  turnId: string;
  attemptCount: number;
  maxAttempts: number;
  lastContent: string;
  /**
   * v14.8.7 §A2: the compact task ledger for this session, when one exists.
   * A resume/continuation must re-assert the SAME task — open-weight models
   * otherwise treat the prior user message as a fresh request after a stall or
   * network event and restart. Passing the ledger anchors "what's left."
   */
  taskLedger?: string | null;
}

export function shouldContinue(
  finishReason: string | undefined,
  ctx: Pick<ContinuationContext, "attemptCount" | "maxAttempts">,
): boolean {
  return (
    (finishReason === "length" || finishReason === "unknown") &&
    ctx.attemptCount < ctx.maxAttempts
  );
}

export function buildContinuationPrompt(ctx: ContinuationContext): string {
  // v14.8.8: the <system-reminder> wrapper (below) already tells the model this
  // is out-of-band, not a user turn — so the body just needs the resume
  // instruction + the task ledger to re-assert, without the verbose disclaimer.
  const base = "Continue exactly from where you left off.";
  const body = ctx.taskLedger?.trim()
    ? "Continuing the SAME task — resume from the in-progress/remaining steps below; do not restart.\n\n" +
      ctx.taskLedger.trim() +
      "\n\n" +
      base
    : base;
  return systemReminder(body);
}
