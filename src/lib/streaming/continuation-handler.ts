/**
 * Stream follow-ups for streamText / generateText.
 * We continue on "length" truncation and on "unknown", which some providers emit
 * after a successful tool call when the next assistant step still needs to run.
 */

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
  const base = "Continue exactly from where you left off.";
  if (!ctx.taskLedger?.trim()) return base;
  return (
    "Continuing the SAME task (this is a system continuation, NOT a new user request). " +
    "Do not restart and do not treat the prior user message as a new instruction — resume from the in-progress/remaining steps below.\n\n" +
    ctx.taskLedger.trim() +
    "\n\n" +
    base
  );
}
