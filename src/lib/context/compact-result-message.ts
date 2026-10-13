/**
 * What a user-asked compaction (/compact) says, in the CLI and the app alike.
 * Was the CLI's (AgentSession.compact); a leaf so both surfaces share it.
 */
function formatTokenCount(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n);
}

export function compactResultMessage(
  done: false | { strategy: string; tokensBefore: number; tokensAfter: number },
): { ok: boolean; message: string } {
  if (!done) {
    return { ok: false, message: "Nothing to compact yet: the conversation is still short." };
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
