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
  ledgerState?: string;
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
  const ledger = ctx.ledgerState?.trim();
  if (ledger) {
    return `${base}\n\nCurrent task state:\n${ledger}`;
  }
  return base;
}
