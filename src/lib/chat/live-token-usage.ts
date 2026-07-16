/**
 * Live token-meter reconciliation (Claude-Code-style smooth tick).
 *
 * The backend emits two kinds of usage during a turn:
 *  - a REAL per-step checkpoint: `input` = full context at that step (already
 *    folds prior steps' output + tool results into history), `output` = THAT
 *    step's output only;
 *  - a throttled stream ESTIMATE: `input` null, `output` = turn-cumulative
 *    visible-text estimate (grows every ~400ms).
 *
 * Between checkpoints we grow the current step's output from the estimate DELTA
 * since the last checkpoint, so the meter climbs live instead of freezing — while
 * never double-counting prior output (which the real `input` already absorbs):
 *
 *   occupancy(t) ≈ lastCheckpointOccupancy + currentStepOutputEstimate
 *
 * Monotonic within a step (floored at the previous value) so estimate jitter can
 * never make the meter dip. At each real checkpoint the numbers snap to the
 * provider's truth; because `input` jumps to absorb the prior step, the meter
 * rises smoothly with no visible dip at the boundary.
 */

export interface LiveUsageState {
  input: number | null;
  output: number;
}

export interface LiveUsageCheckpoint {
  /** The provider's real output for the step that just completed. */
  realOutput: number;
  /** The cumulative estimate value at that checkpoint (delta anchor). */
  estBase: number;
}

/**
 * Compute the next `output` value for the meter on a throttled stream estimate.
 * `estOutput` is the cumulative turn-output estimate carried by the emit.
 */
export function growLiveOutput(args: {
  cur: LiveUsageState | undefined;
  checkpoint: LiveUsageCheckpoint | undefined;
  estOutput: number;
}): number {
  const { cur, checkpoint, estOutput } = args;
  // Before the first real checkpoint this turn (input still null): the
  // cumulative estimate IS the output; grow monotonically.
  if (!cur || cur.input == null || checkpoint == null) {
    return Math.max(cur?.output ?? 0, estOutput);
  }
  // After a checkpoint: confirmed step output + this step's live delta since the
  // checkpoint, floored at the current value so it never dips.
  const liveStep = Math.max(0, estOutput - checkpoint.estBase);
  return Math.max(cur.output, checkpoint.realOutput + liveStep);
}
