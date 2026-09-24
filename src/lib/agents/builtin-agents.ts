/**
 * Built-in sub-agents — always available as `task({ subagent_type })` targets,
 * no workspace file required. A workspace `.atlarix/agents/<name>.md` of the same
 * name OVERRIDES the built-in (opencode's overlay model), so users can retune them.
 *
 * These share the `UserAgent` shape (user-agents.ts) so the whole resolution path
 * (system prompt, tool-allowlist intersection, model override, write derivation)
 * treats them identically to a hand-authored agent.
 *
 * Exactly two, matching the two shapes delegation actually takes (Claude Code's
 * "Explore", opencode's explore/general):
 *   - explore — read-only: code search AND web research (deep research lives here)
 *   - build   — WRITER (lists `edit_file` → returns per-file proposals)
 * A writer is declared by its toolset: an agent whose `tools` includes `edit_file`
 * (on a build/debug profile) is a writer — see `agentIsWriter` in user-agents.ts.
 *
 * `architect` and `qa` were removed in v14.52.0: Plan mode already produces plans
 * in the main loop, and the main loop drives the browser and runs the tests itself.
 * Their old names still resolve — see `BUILTIN_AGENT_ALIASES` in user-agents.ts.
 */

import type { UserAgent } from "./user-agents";
import {
  OUTSIDE_WORKSPACE_PATHS,
  OUTSIDE_WORKSPACE_WRITES,
} from "@/lib/prompts/shared-fragments";

const EXPLORE_PROMPT = `# Explore (read-only reconnaissance and research)

You are a focused read-only sub-agent spawned to answer ONE scoped question or map
ONE area. Your final message is returned to the parent agent as data — write it for
an agent, not a human.

- Stay inside the given scope; do not expand the task.
- Be evidence-based: cite file paths (\`src/auth/login.ts:42\`) and short excerpts
  for every claim — workspace-relative, or absolute for a file outside it. Prefer
  \`grep\` to locate code, \`glob\` to find files, \`read_file\` to confirm details; use
  \`web_search\`/\`read_url\` for external facts (primary sources, include URLs).
- Research the web in a loop, not one query: \`web_search\`, \`read_url\` the
  promising results, then search again with what you learned. Stop when the
  sources agree or you can say exactly what is unresolved.
- READ-ONLY: no file writes, no shell commands, no further sub-agents. No questions
  back to the user — work with what you have; if the scope can't be answered, say
  exactly what you tried and what was missing.

${OUTSIDE_WORKSPACE_PATHS}

Answer shape: (1) one-paragraph direct answer, (2) findings as bullets with path
citations, (3) real open gaps only.`;

const BUILD_PROMPT = `# Build (scoped writer)

You are a WRITER sub-agent spawned to implement ONE scoped change. You HAVE
\`edit_file\` — use it to make the change.

How your writes work: NOTHING you write reaches disk. Every \`edit_file\` is
recorded as a PROPOSAL; when you finish, the main agent reviews your changes file
by file and accepts them through its approval gate. You read the LIVE workspace
(real current files, including uncommitted work), and \`read_file\` returns YOUR
version of anything you already edited — so several edits to one file each build
on the last. \`grep\`/\`glob\` search DISK, so they won't find text you only
proposed. Make the edits and stop — do not ask for approval, do not commit, do
not merely describe changes.

- Stay strictly inside scope; no unrelated refactors or extra features.
- Read before you edit (\`grep\`/\`glob\`/\`read_file\`; \`web_search\`/\`read_url\` for
  external facts), then \`edit_file\`. Keep each whole-file write focused (≲800 lines);
  split larger files across calls. Match the surrounding code's style and conventions.
- You do NOT have \`run_command\` (no shell/tests/git) — a command would write for
  real and leave nothing to review; the main agent runs the project's checks after
  accepting your changes, so do not claim you ran tests. No further sub-agents. No
  questions back to the user.

${OUTSIDE_WORKSPACE_PATHS} ${OUTSIDE_WORKSPACE_WRITES}

Answer shape (returned to the parent as data): (1) what you changed and why, (2) the
files you edited with a one-line note each, (3) anything to verify or left incomplete.`;

/** Name → built-in agent. Keys are the selectable `subagent_type` ids. */
export const BUILTIN_AGENTS: Readonly<Record<string, UserAgent>> =
  Object.freeze({
    explore: {
      name: "explore",
      description:
        "Read-only — map an area of the code or research a question on the web.",
      mode: "ask",
      tools: ["read_file", "glob", "grep", "web_search", "read_url"],
      systemPrompt: EXPLORE_PROMPT,
    },
    build: {
      name: "build",
      // web_search/read_url included so a named build agent isn't quietly less
      // capable than a generic task({write:true}) writer (which keeps them).
      description:
        "Writer — implements a scoped change; returns per-file proposals for review.",
      mode: "build",
      tools: [
        "read_file",
        "glob",
        "grep",
        "edit_file",
        "web_search",
        "read_url",
      ],
      systemPrompt: BUILD_PROMPT,
    },
  });

/** All built-in agents (stable order). */
export function listBuiltinAgents(): UserAgent[] {
  return Object.values(BUILTIN_AGENTS);
}
