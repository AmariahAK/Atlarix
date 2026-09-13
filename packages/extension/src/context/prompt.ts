/**
 * What the summariser is told when a conversation is compacted.
 *
 * ADAPTED FROM the desktop's `src/prompts/context_compaction_prompt.ts`, not
 * copied. That template ends in `## Relevant Files` and asks the model to
 * preserve "exact file paths, commands, error strings" — correct for a coding
 * session and nearly empty for a browser one. A section that answers "(none)"
 * every single time is not a neutral cost: it teaches the model that the
 * template is decorative, and the sections that DO matter get the same
 * treatment.
 *
 * ═══ IT SUMMARISES THE USER'S THREAD, NOT THE PAGES ═══
 *
 * OWNER DECISION, 2026-09-13. An earlier version of this carried a
 * `## Pages and Tabs` section — "URL: what it was for and what it said" — which
 * made the summary a browsing log. Two things are wrong with that, and the
 * second is the one that decided it:
 *
 *   1. It is the wrong CONTENT. What survives a long conversation should be what
 *      the user wanted, decided and now knows — not a catalogue of what the
 *      agent happened to look at on the way. A browsing log is a record of the
 *      tool's activity, and the tool is not the point.
 *
 *   2. COMPACTION MARKERS SYNC. They are one of the four row types that leave
 *      the device (`sessions/sync.ts`), so a section inviting the model to
 *      transcribe page contents was a hole straight through the egress rule —
 *      one the 200-character `tool_label` cap does not cover, because a
 *      compaction row is legitimately allowed 40,000. The rule is now enforced
 *      at both ends: raw results never sync, and the summary is told in as many
 *      words never to copy page text into itself.
 *
 * An ANSWER the user asked for is not page content. "The Pro plan is $19 a
 * month" is the thing they wanted; where it was written is incidental, and if it
 * turns out to matter the page can be read again.
 */

export const COMPACTION_SYSTEM = `You are compressing a conversation so it can continue in a smaller context window.

Output exactly the Markdown structure shown inside <template> and keep the section order unchanged. Do not include the <template> tags in your response.
<template>
## Goal
- [what the user is trying to accomplish, in one sentence]

## Constraints & Preferences
- [anything the user asked for or ruled out, or "(none)"]

## Progress
### Done
- [what has been accomplished, or "(none)"]

### In Progress
- [what is underway right now, or "(none)"]

### Blocked
- [what is stuck and why, or "(none)"]

## Key Decisions
- [a decision and the reason for it, or "(none)"]

## Next Steps
- [the ordered next actions, or "(none)"]

## What the user now knows
- [an answer they asked for and now have, with the exact figure or name, or "(none)"]

## Open Questions
- [what they asked that is still unanswered, or "(none)"]
</template>

Rules:
- Keep every section, even when it is empty.
- Terse bullets, not prose.
- THIS IS A RECORD OF THE USER'S THREAD, NOT A BROWSING LOG. Write what they wanted, what they decided, and what they now know. Do not catalogue the pages you visited, what each one contained, or how you navigated.
- An ANSWER the user asked for belongs here; the page it came from does not. "The Pro plan is $19 a month" is the answer. "The pricing page has a comparison table with four columns" is page content, and it goes nowhere.
- Preserve exact figures, names and dates the user asked for. A number they wanted is the single most important thing to carry forward, and a paraphrase of it is worthless.
- Anything the user stated about themselves, their situation or what they want is a CONSTRAINT and survives compaction even if it looked incidental at the time.
- Never copy text out of a page into this summary. If a detail from a page turns out to matter later, it can be read again.
- Do not mention the summary process or that the context was compacted.
- If a PRIOR SUMMARY is provided, update it: keep what is still true, drop what is stale, merge in what is new. Do not restate it verbatim.`;

const COMPACTION_USER_PREFIX = `Summarise this browsing session so it can be continued. The messages after your summary will carry on from it.

--- CONVERSATION TO SUMMARISE ---

`;

/** How much of a previous summary is handed forward. */
const PRIOR_SUMMARY_MAX_CHARS = 12_000;

/**
 * The user-side prefix, folding a previous generation's summary in as a LABELLED
 * prior rather than as another line of transcript.
 *
 * WHY THAT DISTINCTION IS THE WHOLE POINT. Left in the transcript, the previous
 * summary is flattened and truncated like any other message — so generation 3
 * compresses a clipped, structureless read of generation 2, and a long session's
 * `## Goal` drifts toward whatever it happened to be doing an hour ago. Handed
 * over as a prior, it gets its own budget and an instruction to update it.
 */
export function buildCompactionUserPrompt(
  transcript: string,
  prior?: { summaryText: string; generation: number } | null,
): string {
  if (!prior?.summaryText.trim()) return `${COMPACTION_USER_PREFIX}${transcript}`;
  const head = prior.summaryText.trim().slice(0, PRIOR_SUMMARY_MAX_CHARS);
  return (
    `PRIOR SUMMARY (generation ${prior.generation}) — for orientation only; do not copy it back verbatim:\n\n` +
    `---\n${head}\n---\n\n` +
    `Summarise only the conversation below, and merge what it adds into the prior summary.\n\n` +
    `${COMPACTION_USER_PREFIX}${transcript}`
  );
}
