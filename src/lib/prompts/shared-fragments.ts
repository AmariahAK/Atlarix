/**
 * Prompt text that MUST read identically in more than one prompt.
 *
 * The reuse-first ladder is the accuracy spine of the main agent, and a writer
 * sub-agent needs it more than anyone: it works from a narrow scope with no view
 * of what already exists in the codebase, which makes it the actor most likely
 * to write a helper that is already three files over. But sub-agents get NO
 * AGENTS.md — their whole system prompt is the small skill in `src/skills/
 * subagents/` — so the guidance has to be added there deliberately.
 *
 * Keeping one copy here (spliced into both at load) is the point: a second
 * hand-maintained copy is exactly how the mode label drifted until the header
 * and `<tools_registry>` disagreed inside one rendered prompt.
 */

/** Placeholder markdown files use to request a shared fragment. */
const PLACEHOLDER_PATTERN = /\{\{([A-Z0-9_]+)\}\}/g;

export const REUSE_FIRST_LADDER = `Be lazy about the solution, never about reading: reuse what the codebase, the language or an installed dependency already has before writing anything, and make the smallest diff that fully solves the task, in the surrounding code's style. Never cut corners on validation, security, data loss or accessibility.`;

/**
 * One spelling rule for reaching another project.
 *
 * The tools have allowed this for a while (reads anywhere, writes behind a
 * per-folder grant), but nothing SAID so — the permission lived only in parameter
 * descriptions. Observed result: asked to look at a sibling repo, the agent read the
 * workspace as a wall, abandoned `glob`/`read_file` for `pwd`/`ls`/`find`, and then
 * guessed the wrong parent directory. Sub-agents fared worse: the read-only scout
 * has no `run_command` to fall back on.
 *
 * Stated as ONE canonical form (absolute), matching opencode, Claude Code, Gemini
 * CLI and Copilot. Deliberately not "always use absolute paths": in-workspace work
 * is the overwhelming majority, relative already works, and pushing every path to
 * absolute would fight the training prior and lengthen every call for nothing.
 */
export const OUTSIDE_WORKSPACE_PATHS = `The workspace is your default scope, not a wall: \`read_file\`, \`glob\` and \`grep\` take an absolute path to another project (no approval needed; don't shell out to \`find\` or \`ls\`). Don't guess where a project lives; ask.`;

/**
 * The write half, kept separate so it reaches only prompts whose agent HAS
 * `edit_file`. Naming a tool a mode cannot call is the failure the v14.22.0
 * standing guard exists to catch (`mode_system_consistency.test.ts`), and telling a
 * read-only scout how outside writes work is at best noise, at worst an invitation
 * to attempt one.
 */
export const OUTSIDE_WORKSPACE_WRITES = `\`edit_file\` takes one too; the first write to an outside folder asks the user once, and the grant covers commands there.`;

const FRAGMENTS: Record<string, string> = {
  REUSE_FIRST_LADDER,
  OUTSIDE_WORKSPACE_PATHS,
  OUTSIDE_WORKSPACE_WRITES,
};

/**
 * Replace `{{FRAGMENT_NAME}}` placeholders with their shared text.
 *
 * An unknown placeholder is left verbatim rather than blanked — a visible
 * `{{TYPO}}` in the prompt is a bug you can see; a silently missing paragraph is
 * one you cannot.
 */
export function applySharedPromptFragments(text: string): string {
  if (!text.includes("{{")) return text;
  return text.replace(PLACEHOLDER_PATTERN, (match, name: string) =>
    name in FRAGMENTS ? FRAGMENTS[name] : match,
  );
}
