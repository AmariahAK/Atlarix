/**
 * Context Compaction Prompt - Phase 6 (OpenCode/Claude Code style)
 * Used when context fills; AI produces a continuation prompt for seamless session memory.
 */

/** v3.6: Build-guide style summary for context window management (400-600 words). */
export const CONTEXT_COMPACTION_SYSTEM = `You are compressing a coding session for context window management.
Create a dense summary preserving:
1. What the user is building (the goal)
2. What has been completed (files created/modified, decisions made)
3. What is in progress or blocked
4. Critical technical decisions and why they were made
5. Errors encountered and how resolved
6. Active file paths and current state
Be specific. Include file names, function names, variable names.
Vague summaries are useless. Target: 400-600 words.
Format as structured markdown. No pleasantries.`;

export const CONTEXT_COMPACTION_USER_PREFIX = `Summarize this conversation for continuity. Focus on information helpful for continuing:
- What we did (files, features, fixes)
- What we're currently working on
- Relevant files and their purposes
- Key decisions and patterns
- Next steps and open questions

The next messages will follow your summary.

--- CONVERSATION TO SUMMARIZE ---

`;
