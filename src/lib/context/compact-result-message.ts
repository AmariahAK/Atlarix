/**
 * What a user-asked compaction (/compact) says, in the CLI and the app alike.
 * Was the CLI's (AgentSession.compact); a leaf so both surfaces share it.
 */
function formatTokenCount(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n);
}

/**
 * What a forced compaction did. "failed" is its own answer: a summary the model
 * could not write used to come back as "still short" (2 of 2, 2026-10-20).
 */
export type ForcedCompaction =
  | { ok: true; strategy: string; tokensBefore: number; tokensAfter: number }
  | { ok: false; reason: "short" | "failed" };

export function compactResultMessage(done: ForcedCompaction): { ok: boolean; message: string } {
  if (!done.ok) {
    return {
      ok: false,
      message:
        done.reason === "failed"
          ? "Couldn't compact: the model didn't return a summary. Try again, or switch model."
          : "Nothing to compact yet: the conversation is still short.",
    };
  }
  // Said as what happened: a summary, or (when the summary could not be made)
  // only older tool output dropped.
  const what =
    done.strategy === "summarized"
      ? "Atlarix now works from a summary of it."
      : "Older tool output was dropped; the conversation itself is kept.";
  return {
    ok: true,
    message: `Compacted · ~${formatTokenCount(done.tokensBefore)} → ~${formatTokenCount(done.tokensAfter)} tokens. Earlier messages stay on screen; ${what}`,
  };
}
