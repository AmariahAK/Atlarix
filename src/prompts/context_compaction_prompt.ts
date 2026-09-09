/**
 * Context Compaction Prompt - v7.1.2
 * OpenCode-style summarization template with strict markdown sections.
 */

export const CONTEXT_COMPACTION_SYSTEM = `You are compressing a coding session for context window management.

Output exactly the Markdown structure shown inside <template> and keep the section order unchanged. Do not include the <template> tags in your response.
<template>
## Goal
- [single-sentence task summary]

## Constraints & Preferences
- [user constraints, preferences, specs, or "(none)"]

## Progress
### Done
- [completed work or "(none)"]

### In Progress
- [current work or "(none)"]

### Blocked
- [blockers or "(none)"]

## Key Decisions
- [decision and why, or "(none)"]

## Next Steps
- [ordered next actions or "(none)"]

## Critical Context
- [important technical facts, errors, open questions, or "(none)"]

## Relevant Files
- [file or directory path: why it matters, or "(none)"]
</template>

Rules:
- Keep every section, even when empty.
- Use terse bullets, not prose paragraphs.
- Preserve exact file paths, commands, error strings, and identifiers when known.
- Do not mention the summary process or that context was compacted.
- If a PRIOR SUMMARY is provided, update it by preserving still-true details, removing stale ones, and merging in new facts. Do not repeat or rephrase prior content verbatim.`;

export const CONTEXT_COMPACTION_USER_PREFIX = `Summarize this conversation for continuity. Focus on information helpful for continuing:
- What we did (files, features, fixes)
- What we're currently working on
- Relevant files and their purposes
- Key decisions and patterns
- Next steps and open questions

The next messages will follow your summary.

--- CONVERSATION TO SUMMARIZE ---

`;

export function buildCompactionUserPromptPrefix(prior?: {
  summaryText: string;
  compactionGeneration: number;
}): string {
  if (!prior?.summaryText?.trim()) {
    return CONTEXT_COMPACTION_USER_PREFIX;
  }
  const gen = prior.compactionGeneration ?? 0;
  const head = prior.summaryText.trim().slice(0, 12_000);
  return `${CONTEXT_COMPACTION_USER_PREFIX}PRIOR SUMMARY (generation ${gen}) — for orientation only; do not copy verbatim:\n\n---\n${head}\n---\n\nSummarize only the conversation segment below that adds new information.\n\n`;
}
