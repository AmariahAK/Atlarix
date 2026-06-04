import { getActiveModelDisplayName } from "./active-model-identity";

/** Canonical git identity for all agent-made commits. */
export const ATLARIX_GIT_AUTHOR_NAME = "atlarix-agent";
export const ATLARIX_GIT_AUTHOR_EMAIL = "agent@atlarix.dev";

export const ATLARIX_CO_AUTHOR_TRAILER =
  `Co-authored-by: ${ATLARIX_GIT_AUTHOR_NAME} <${ATLARIX_GIT_AUTHOR_EMAIL}>`;

/** "<Model Display Name> agent" when a model is known, else "atlarix-agent". */
export function gitAuthorNameForModel(
  modelDisplayName?: string | null,
): string {
  const name = modelDisplayName?.trim();
  return name ? `${name} agent` : ATLARIX_GIT_AUTHOR_NAME;
}

export async function getGitAuthor() {
  return {
    name: gitAuthorNameForModel(getActiveModelDisplayName()),
    email: ATLARIX_GIT_AUTHOR_EMAIL,
  };
}

/** Strip characters that could break shell quoting in `-c user.name="..."`. */
function sanitizeForShellDoubleQuotes(value: string): string {
  return value.replace(/["\\$`]/g, "").trim();
}

/**
 * Rewrite bare `git commit` invocations so the commit is attributed to the
 * agent identity (`"<Model> agent" <agent@atlarix.dev>`) without touching the
 * user's git config. No-op when the command already sets an author/identity
 * or when no `git commit` is present.
 */
export function injectAgentGitIdentity(
  command: string,
  modelDisplayName?: string | null,
): string {
  if (!/\bgit\s+commit\b/.test(command)) return command;
  if (/--author[=\s]|user\.name|user\.email/.test(command)) return command;
  const name = sanitizeForShellDoubleQuotes(
    gitAuthorNameForModel(modelDisplayName ?? getActiveModelDisplayName()),
  );
  if (!name) return command;
  return command.replace(
    /\bgit(\s+commit\b)/g,
    `git -c user.name="${name}" -c user.email="${ATLARIX_GIT_AUTHOR_EMAIL}"$1`,
  );
}
