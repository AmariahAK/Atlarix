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
  | {
      ok: false;
      /**
       * "short": too little conversation to summarise. "failed": the model
       * returned no summary. "nothing-freed": the compactor ran and freed
       * nothing. "no-history": the turn\'s in-memory history was not there to
       * compact. The last two used to be reported as "short", which told the
       * owner a 300k session was too small (2026-10-31).
       */
      reason: "short" | "failed" | "nothing-freed" | "no-history";
      /** Current size, when known, so the message can say it. */
      tokens?: number;
    };

/** Why it did not compact, in the user\'s words — each cause said apart. */
function refusalMessage(done: { reason: "short" | "failed" | "nothing-freed" | "no-history"; tokens?: number }): string {
  const size = typeof done.tokens === "number" && done.tokens > 0 ? ` (about ${Math.round(done.tokens / 1000)}k tokens)` : "";
  switch (done.reason) {
    case "failed":
      return "Couldn't compact: the model didn't return a summary. Try again, or switch model.";
    case "nothing-freed":
      return `Couldn't compact${size}: nothing could be freed. Start a new chat, or /handoff to carry the work over.`;
    case "no-history":
      return "Couldn't compact: this turn's history isn't in memory any more. Start a new chat, or /handoff to carry the work over.";
    default:
      return "Nothing to compact yet: the conversation is still short.";
  }
}

export function compactResultMessage(done: ForcedCompaction): { ok: boolean; message: string } {
  if (!done.ok) {
    return {
      ok: false,
      message: refusalMessage(done),
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
