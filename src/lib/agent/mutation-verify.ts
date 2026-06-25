/**
 * Per-turn mutation-verification tracker — the `run_command` + edit symmetry to
 * the stop-hook gate. Records the outcome of the most recent *state-changing*
 * mutation in a turn (a `run_command` exit, or an `edit_file`/`write_file` that
 * verified or not). The agentic loop (run-agent-turn.ts) consults this before
 * honoring a turn-ending prose-only round: if the model's most recent mutation
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
 * Per-turn set of files whose write did NOT verify on disk (the bytes we
 * intended didn't match what was read back — a truncated/failed write). This
 * accumulates the running true/false state across all edits in the turn so a
 * single consolidated "self review" can fire at the completion gate, instead
 * of nagging after every edit. A later successful write of the same path clears
 * it ("most recent wins"). Spends ZERO model tokens on the happy path.
 */
const unverifiedEditsByTurn = new Map<string, Set<string>>();

/** Mark a file's write as not-yet-verified (bytes didn't match on re-read). */
export function recordUnverifiedEdit(turnId: string, path: string): void {
  let set = unverifiedEditsByTurn.get(turnId);
  if (!set) {
    set = new Set<string>();
    unverifiedEditsByTurn.set(turnId, set);
  }
  set.add(path);
}

/** Clear a prior not-verified flag for a path (a later write of it landed). */
export function clearUnverifiedEdit(turnId: string, path: string): void {
  unverifiedEditsByTurn.get(turnId)?.delete(path);
}

/**
 * End-of-turn self review: if any edit this turn never verified on disk, return
 * a single consolidated nudge naming those files so the model re-checks them
 * before finishing. Null when everything landed — so it costs nothing unless
 * something actually failed.
 */
export function getUnverifiedEditFeedback(turnId: string | undefined): string | null {
  if (turnId == null) return null;
  const set = unverifiedEditsByTurn.get(turnId);
  if (!set || set.size === 0) return null;
  const list = [...set].map((p) => `- ${p}`).join("\n");
  return (
    "Before finishing, re-check these file(s) — their on-disk content did not " +
    "match what you wrote (the write may have failed or been altered):\n" +
    `${list}\n` +
    "Re-read each, re-apply the change if needed, then finish."
  );
}

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
  if (turnId != null) {
    lastMutationByTurn.delete(turnId);
    unverifiedEditsByTurn.delete(turnId);
  }
}
