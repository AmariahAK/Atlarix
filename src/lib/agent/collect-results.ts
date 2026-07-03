/**
 * R2 — collect pending background results into a single model-facing block.
 *
 * This is the body returned by the internal `collect_results` tool that an
 * auto-wake continuation turn is FORCED to call (see `chat_stream_handlers.ts`).
 * Delivering finished background-command / sub-agent results as a real tool
 * result (persisted via native history) — rather than a transient user-message
 * injection — means a weak/open-weight model receives them on a channel it is
 * trained to consume and cannot skip. Take-once: draining here is what keeps the
 * prepareStep injection from also delivering them (no double-consume).
 */
import {
  takePendingBackgroundCommandResults,
  takePendingStalledAdvisories,
  hasPendingBackgroundCommandResults,
  hasPendingStalledAdvisories,
} from "./background-commands";
import {
  takePendingSubagentResults,
  hasPendingSubagentResults,
} from "../agents/subagent-results";

export function collectPendingBackgroundResultsBody(chatId: number): string {
  const parts = [
    takePendingBackgroundCommandResults(chatId),
    takePendingSubagentResults(chatId),
    takePendingStalledAdvisories(chatId),
  ].filter((p): p is string => !!p);
  return parts.length ? parts.join("\n\n") : "No pending background results.";
}

/**
 * Whether a wake/continuation turn has finished background work (commands,
 * sub-agents, OR stall advisories) to deliver via the forced `collect_results`
 * tool. Strictly NON-destructive — this is the wake-turn *decision*, computed
 * ONCE up front (before context assembly) so the take-once drains that follow
 * have a single consumer: `collect_results` on a wake turn, or the context
 * loaders / prepareStep injection on a non-wake turn. `isWake` is
 * `req.continueAfterQuestions`.
 */
export function computeWakePendingResults(
  chatId: number,
  isWake: boolean,
): boolean {
  return (
    isWake &&
    (hasPendingBackgroundCommandResults(chatId) ||
      hasPendingSubagentResults(chatId) ||
      hasPendingStalledAdvisories(chatId))
  );
}
