/**
 * Which QUEUED operations does a newly-saved permission rule already cover?
 *
 * The gate is evaluated when an operation is REQUESTED, but a rule is written
 * when one is DECIDED. So a batch of edits queued together were all gated before
 * the rule existed, and nothing ever went back for them: saying "always allow
 * .ts" on the first card left the other four still asking. Reported as *"always
 * allow works when it's asked once, but if a batch of file changes come in a row,
 * all will not work"*.
 *
 * Pure and resolver-injected so it can be tested without Electron or the
 * database — the real caller passes `runFilePermissionPreflight`.
 */

export type PendingFileOperation = {
  id: string;
  operation: string;
  /** Workspace-relative, already normalised by the caller. */
  relativePath: string;
};

export type SweepVerdict = "auto_allow" | "auto_deny" | "prompt";

/**
 * Operations the new rules now auto-allow.
 *
 * **Only ever returns auto-allows.** The resolver is the same one the request
 * path uses, so this can never approve something a fresh request would not have.
 * A `auto_deny` verdict is deliberately ignored rather than acted on: the user is
 * part-way through deciding this batch, and silently rejecting queued work is a
 * worse surprise than leaving the card up.
 */
export function selectOperationsCoveredByRules(
  pending: readonly PendingFileOperation[],
  resolve: (operation: string, relativePath: string) => SweepVerdict,
): PendingFileOperation[] {
  const covered: PendingFileOperation[] = [];
  for (const op of pending) {
    if (!op.relativePath) continue;
    if (resolve(op.operation, op.relativePath) === "auto_allow") covered.push(op);
  }
  return covered;
}

/**
 * One line naming what a rule swept up.
 *
 * A rule that silently green-lights several file writes is exactly what the
 * approval queue exists to prevent. The goal is to stop ASKING repeatedly, not to
 * stop telling — so the operations proceed, and the user still sees which.
 */
export function describeSweptOperations(paths: readonly string[]): string {
  const n = paths.length;
  return `${n} more ${n === 1 ? "edit" : "edits"} auto-approved by this rule`;
}
