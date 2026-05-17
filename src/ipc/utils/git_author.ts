/** Canonical git identity for all agent-made commits. */
export const ATLARIX_GIT_AUTHOR_NAME = "atlarix-agent";
export const ATLARIX_GIT_AUTHOR_EMAIL = "agent@atlarix.dev";

export const ATLARIX_CO_AUTHOR_TRAILER =
  `Co-authored-by: ${ATLARIX_GIT_AUTHOR_NAME} <${ATLARIX_GIT_AUTHOR_EMAIL}>`;

export async function getGitAuthor() {
  return {
    name: ATLARIX_GIT_AUTHOR_NAME,
    email: ATLARIX_GIT_AUTHOR_EMAIL,
  };
}
