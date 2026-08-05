/**
 * Tell the model the sandbox was there.
 *
 * THE GAP
 * -------
 * A sandboxed command that fails on a blocked write is handled when the failing tool
 * prints the path: `parseSandboxDenialsFromOutput` scrapes it, the interceptor raises a
 * grant card, the user approves, the command re-runs.
 *
 * When no path can be scraped, the model was told nothing at all — not that a sandbox
 * existed, not what its writable roots were, not that a grant was an option. It saw a
 * non-zero exit and some output, and could not reason about a boundary it did not know
 * was there. That is not missing kernel information; it is information the harness
 * already holds and never says.
 *
 * WHY THERE IS NO CLASSIFICATION HERE
 * -----------------------------------
 * An earlier version of this file tried to work out WHETHER the failure was a sandbox
 * denial — permission-signal regexes, filesystem-evidence heuristics, a probe for the
 * failing tool's likely cache directory. All of it was guessing, and guessing wrong is
 * worse than saying nothing: it produces a confident explanation for a failure it does
 * not understand, and sends the user a grant request for a folder unrelated to the
 * problem.
 *
 * The model is better at reading an error message than any regex here could be. So this
 * states facts only — the sandbox was applied, these were its writable roots, this was
 * the working directory — and lets the model decide whether they are relevant. The
 * harness supplies what the model cannot see; it does not interpret on its behalf.
 *
 * That includes not telling it what to DO about them. An earlier version ended with
 * "name the folder it needs and ask the user to grant it, then re-run…", which is the
 * harness scripting a decision it has no basis for: it does not know the failure was a
 * denial, and the recovery ladder (read the error, take a concrete corrective step) is
 * already in AGENTS.md for every tool error. Repeating it here per failed command is cost
 * without information.
 */

export type SandboxFailureContext = {
  /** Whether a sandbox was actually applied to this run. */
  sandboxed: boolean;
  workingDir: string;
  /** Roots the sandbox granted write access to. */
  writableRoots: readonly string[];
  /** Read-only mode denies workspace writes too, which changes what the roots mean. */
  readOnly?: boolean;
  exitCode: number;
  /**
   * True when `parseSandboxDenialsFromOutput` already attributed a path — that path gets
   * its own grant card, so repeating the context here would describe one failure twice.
   */
  alreadyAttributed: boolean;
};

/**
 * The sandbox's own context for a failed command, or null when there is nothing to add.
 *
 * Deliberately says nothing about the CAUSE. The command's output is already in the
 * error the model receives; this is only the part the output cannot contain.
 */
export function describeSandboxFailureContext(
  input: SandboxFailureContext,
): string | null {
  if (!input.sandboxed) return null;
  if (input.exitCode === 0) return null;
  if (input.alreadyAttributed) return null;

  const roots = input.writableRoots.filter(Boolean);
  return [
    `This command ran inside the write-confining sandbox${input.readOnly ? " in READ-ONLY mode (workspace writes denied too)" : ""}, and no denied path could be read from its output.`,
    `Writable roots for this run: ${roots.length ? roots.join(", ") : "(none)"}`,
    `Working directory: ${input.workingDir}`,
  ].join("\n");
}
