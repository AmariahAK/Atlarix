/** Canonical git identity for all agent-made commits. */
export const ATLARIX_GIT_AUTHOR_NAME = "atlarix-agent";
export const ATLARIX_GIT_AUTHOR_EMAIL = "agent@atlarix.dev";

export const ATLARIX_CO_AUTHOR_TRAILER = `Co-authored-by: ${ATLARIX_GIT_AUTHOR_NAME} <${ATLARIX_GIT_AUTHOR_EMAIL}>`;

export async function getGitAuthor() {
  return {
    name: ATLARIX_GIT_AUTHOR_NAME,
    email: ATLARIX_GIT_AUTHOR_EMAIL,
  };
}

/** Strip characters that could break shell quoting in `-c user.name="..."`. */
function sanitizeForShellDoubleQuotes(value: string): string {
  return value.replace(/[\"\\$`]/g, "").trim();
}

/**
 * Rewrite bare `git commit` invocations so the commit is attributed to the
 * canonical agent identity (`atlarix-agent <agent@atlarix.dev>`) without
 * touching the user's git config. No-op when the command already sets an
 * author/identity or when no `git commit` is present.
 *
 * Used only as a fallback on a machine with no configured git identity, so a
 * bare `git commit` still succeeds. The identity is always the agent, never a
 * model name — a commit must never be authored as "<Model> agent".
 */
export function injectAgentGitIdentity(command: string): string {
  if (!/\bgit\s+commit\b/.test(command)) return command;
  if (/--author[=\s]|user\.name|user\.email/.test(command)) return command;
  const name = sanitizeForShellDoubleQuotes(ATLARIX_GIT_AUTHOR_NAME);
  if (!name) return command;
  return command.replace(
    /\bgit(\s+commit\b)/g,
    `git -c user.name="${name}" -c user.email="${ATLARIX_GIT_AUTHOR_EMAIL}"$1`,
  );
}
