/**
 * Did this note get copied off a page?
 *
 * WHY THIS EXISTS AT ALL. Atlarix's promise is that page content never leaves
 * the device, and it is enforced structurally for conversations by a Postgres
 * CHECK — a `tool_label` row is capped at 200 characters, so a page read
 * cannot fit. Notes break that arithmetic: they are 26 KB, they are ABOUT the
 * user (which is exactly the category the rule permits to leave), and they sync.
 * A size cap on a legitimately-large column is not an egress rule; that is the
 * precise shape of the `## Pages and Tabs` near-miss already recorded in
 * `docs/TODO.md`, where a compaction row's legitimate 40,000 characters became a
 * hole for the same reason.
 *
 * WHAT THIS LAYER UNIQUELY CATCHES. A database constraint can recognise the
 * SHAPE of a page dump; only the client can compare a note against what the
 * agent actually read this turn. That comparison is the sole control that
 * targets the real rule — "only what the user told you themselves, never
 * anything you read off a page" — rather than a proxy for it.
 *
 * PURE, AND THAT IS DELIBERATE. `sessions/sync.ts` makes its projection a pure
 * function so a test can assert the egress rule directly instead of inspecting
 * a request. Same reasoning, same shape.
 *
 * WHAT IT DOES NOT CATCH, stated so nobody reads it as more than it is: a model
 * that PARAPHRASES a page defeats every check here, and should — "the Pro plan
 * is $19 a month" is an answer the user wanted, not page content, and the
 * prompt says so. The residual gap is closed by visibility, not by code: every
 * note is listed, readable and deletable by the user.
 */

/** Long enough that prose cannot collide by accident; short enough to catch a paste. */
export const MIN_VERBATIM_RUN = 24;

/** Words, lowercased, punctuation dropped — so reformatting does not evade it. */
function shingleWords(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * The `\p{L}\p{N}` above is not decoration. An ASCII `\w` would strip every
 * character of a language that does not use the Latin alphabet, turning a
 * Japanese or Arabic note into an empty word list — which reads as "no overlap"
 * and silently disables the check for exactly the users least likely to report
 * it. The same trap is recorded against the sanitiser in `docs/TODO.md`.
 */

function runsOf(words: string[], n: number): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i + n <= words.length; i++) {
    out.add(words.slice(i, i + n).join(" "));
  }
  return out;
}

export type CopyVerdict =
  | { copied: false }
  | { copied: true; overlap: string };

/**
 * Does `body` share a long verbatim run with anything the agent just read?
 *
 * `recentToolResults` is every tool result in the current turn — NOT only page
 * reads. A connector's output is exactly as much third-party content as a page,
 * and after account-side MCP there is no reason to treat them differently.
 */
export function looksCopiedFromPage(
  body: string,
  recentToolResults: readonly string[],
): CopyVerdict {
  const bodyWords = shingleWords(body);
  if (bodyWords.length < MIN_VERBATIM_RUN) return { copied: false };
  const bodyRuns = runsOf(bodyWords, MIN_VERBATIM_RUN);
  if (bodyRuns.size === 0) return { copied: false };

  for (const result of recentToolResults) {
    const words = shingleWords(result);
    if (words.length < MIN_VERBATIM_RUN) continue;
    for (let i = 0; i + MIN_VERBATIM_RUN <= words.length; i++) {
      const run = words.slice(i, i + MIN_VERBATIM_RUN).join(" ");
      if (bodyRuns.has(run)) return { copied: true, overlap: run };
    }
  }
  return { copied: false };
}

/** What the model is told. Names the rule, not just the refusal. */
export function copiedRefusal(overlap: string): string {
  const shown = overlap.length > 120 ? `${overlap.slice(0, 120)}…` : overlap;
  return (
    `Not saved — that note repeats something you read this turn, word for ` +
    `word: "${shown}". Notes are for what the USER told you about ` +
    `themselves, not for page or connector content. If this is genuinely ` +
    `something they said or decided, write it in your own words.`
  );
}
