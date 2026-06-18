/**
 * Per-turn mutation-verification tracker — the `run_command` + edit symmetry to
 * the stop-hook gate. Records the outcome of the most recent *state-changing*
 * mutation in a turn (a `run_command` exit, or an `edit_file`/`write_file` that
 * verified or not). The agentic loop (run-agent-turn.ts) consults this before
 * honoring a completion request (the `task_complete` tool, the `<task_complete>`
 * tag, or the no-tool-call safety-net): if the model's most recent mutation
 * failed or didn't verify, completion is suppressed and the model is nudged to
 * fix/verify first — bounded, like the stop-hook gate.
 *
 * "Most recent wins": a later successful mutation clears a prior failure, so a
 * model that fixes its mistake before finishing isn't trapped. Set in
 * `runToolExecute` (which owns the turnId); read via `mutationVerifyGate`.
 */

type MutationOutcome = { feedback: string } | null;

const lastMutationByTurn = new Map<string, MutationOutcome>();

/**
 * Record the outcome of a state-changing mutation. `ok=true` clears any prior
 * failure for the turn; `ok=false` stores the feedback to surface at the gate.
 */
export function recordMutationOutcome(
  turnId: string,
  ok: boolean,
  feedback?: string,
): void {
  lastMutationByTurn.set(turnId, ok ? null : { feedback: feedback ?? "" });
}

/** Gate feedback if the most recent mutation in the turn failed/unverified. */
export function getMutationFailureFeedback(
  turnId: string | undefined,
): string | null {
  if (turnId == null) return null;
  return lastMutationByTurn.get(turnId)?.feedback ?? null;
}

export function clearMutationOutcomes(turnId: string | undefined): void {
  if (turnId != null) lastMutationByTurn.delete(turnId);
}
