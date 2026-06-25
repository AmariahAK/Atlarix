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

export function buildContinuationPrompt(_ctx: ContinuationContext): string {
  return "Continue exactly from where you left off.";
}
