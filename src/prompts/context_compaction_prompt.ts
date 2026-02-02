/**
 * Context Compaction Prompt - Phase 6 (OpenCode/Claude Code style)
 * Used when context fills; AI produces a continuation prompt for seamless session memory.
 */

export const CONTEXT_COMPACTION_SYSTEM = `You are creating a continuation prompt for a coding session that has exceeded the context window.

Your output will replace the summarized messages. The next messages in the conversation will follow your summary.

Analyze the conversation and create a comprehensive continuation prompt. The new session will NOT have access to the conversation history, so be thorough but concise.

**Required sections (use clear headers):**

1. **Project Overview**
   - Tech stack and frameworks
   - Project structure and key directories
   - Dependencies and integrations

2. **What We Accomplished**
   - Files created/modified (with paths)
   - Features implemented
   - Bugs fixed
   - Commands run

3. **Current State**
   - Active task/feature being worked on
   - Files currently open/relevant
   - Last action taken

4. **Context & Decisions**
   - Design patterns chosen
   - Architecture decisions made
   - Code style conventions
   - Any constraints or requirements

5. **Next Steps**
   - Immediate next action
   - Planned features
   - Known issues to address

6. **Important Notes**
   - Blockers or challenges encountered
   - Workarounds implemented
   - Things to remember

Format as clear prose or bullet points. No XML tags. Assume the reader has zero context from this conversation.`;

export const CONTEXT_COMPACTION_USER_PREFIX = `Summarize this conversation for continuity. Focus on information helpful for continuing:
- What we did (files, features, fixes)
- What we're currently working on
- Relevant files and their purposes
- Key decisions and patterns
- Next steps and open questions

The next messages will follow your summary.

--- CONVERSATION TO SUMMARIZE ---

`;
