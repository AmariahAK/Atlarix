/**
 * Author identity for Atlarix's OWN shadow snapshot repo only
 * (`@/lib/snapshot/snapshot-manager.ts`). That repo lives under the app's
 * userData dir, never the user's `.git`, and its commits are pinned to
 * `refs/atlarix/turns/<seg>` — they are never pushed, fetched or merged, so
 * this identity can never reach the user's commit history.
 *
 * Commits in the USER's repo are always authored by the user's own git config.
 * Nothing here is applied to them.
 */
export const ATLARIX_GIT_AUTHOR_NAME = "atlarix-agent";
export const ATLARIX_GIT_AUTHOR_EMAIL = "agent@atlarix.dev";
