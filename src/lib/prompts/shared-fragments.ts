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

export const REUSE_FIRST_LADDER = `Be lazy about the SOLUTION, never about reading. Before writing code, climb this ladder and stop at the first rung that fits:

1. Does this need to exist at all? (skip speculative work)
2. Is it already in the codebase? Reuse it.
3. Does the language / standard library cover it?
4. Is there a native platform or framework feature?
5. Is there an already-installed dependency?
6. Can it be a one-liner?
7. Otherwise, write the minimum that works.

Never cut corners on validation, trust-boundary checks, security, data-loss handling, or accessibility — trim only unnecessary complexity. Make the smallest diff that fully solves the task, and match the surrounding code's style and conventions.`;

const FRAGMENTS: Record<string, string> = {
  REUSE_FIRST_LADDER,
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
