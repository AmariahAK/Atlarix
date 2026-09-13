/**
 * What the summariser is told when a conversation is compacted.
 *
 * ADAPTED FROM the desktop's `src/prompts/context_compaction_prompt.ts`, not
 * copied. That template ends in `## Relevant Files`, and it asks the model to
 * preserve "exact file paths, commands, error strings" — correct for a coding
 * session and nearly empty for a browser one. A section that answers "(none)"
 * every single time is not a neutral cost: it teaches the model that the
 * template is decorative, and the sections that DO matter get the same
 * treatment.
 *
 * So the structure is the desktop's and the vocabulary is this product's: pages
 * and tabs instead of files, URLs and exact on-page wording instead of paths and
 * commands.
 */

export const COMPACTION_SYSTEM = `You are compressing a browsing session so it can continue in a smaller context window.

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

## Critical Context
- [facts established from pages, exact figures, error messages, open questions, or "(none)"]

## Pages and Tabs
- [URL or page name: what it was for and what it said, or "(none)"]
</template>

Rules:
- Keep every section, even when it is empty.
- Terse bullets, not prose.
- Preserve exact URLs, names, figures, dates and error text. A number the user asked for is the single most important thing to carry forward, and a paraphrase of it is worthless.
- Findings, not navigation. "The pricing page lists $19/month" is worth keeping; "opened three tabs and scrolled" is not.
- Anything the user stated about themselves, their situation or what they want is a CONSTRAINT and survives compaction even if it looks incidental.
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
