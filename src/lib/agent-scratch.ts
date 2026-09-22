import os from "node:os";
import path from "node:path";
import { workspaceSlug } from "./agent-memory";

/**
 * The prefix every Atlarix-owned temp directory shares.
 *
 * Load-bearing for the sweep: it is the difference between deleting our own
 * leftovers and deleting a user's files. Anything under `os.tmpdir()` that does
 * NOT start with this is somebody else's, and the sweep must not touch it.
 */
export const ATLARIX_TEMP_PREFIX = "atlarix-";

/** The one directory the agent is told to use for scratch files. */
export const AGENT_SCRATCH_ROOT_NAME = `${ATLARIX_TEMP_PREFIX}scratch`;

/**
 * A per-workspace scratch directory the agent is told about by name.
 *
 * WHY THIS EXISTS. Models reach for `/tmp` constantly, and in the read-only
 * modes that was not a habit but a consequence: `/tmp` plus the toolchain caches
 * were the only writable places the sandbox left. So files accumulated at paths
 * we chose not to own — and could not clean, because a bare `/tmp` sweep would
 * sit next to the user's own files and one bad glob would delete them.
 *
 * Naming a directory fixes both ends at once. The model stops guessing, and
 * everything it writes lands somewhere the sweep can safely remove by prefix.
 *
 * PER WORKSPACE, NOT PER SESSION, and that is a prompt-cache decision rather
 * than a filesystem one. This path is published in the runtime identity block,
 * which lives in the cache-stable header alongside `memoryDir` and
 * `workspaceRoot`. A per-session path would differ for every chat in a
 * workspace, so two chats in the same project could no longer share a cached
 * prefix — a real per-turn cost, to separate scratch files nobody is isolating.
 *
 * `os.tmpdir()` rather than a fixed `/tmp`: on macOS that is the per-user
 * `/var/folders/…` root the OS already prunes, and on Windows it follows a
 * redirected `%TEMP%` instead of guessing.
 */
export function agentScratchDirFor(workspacePath: string): string {
  return path.join(
    os.tmpdir(),
    AGENT_SCRATCH_ROOT_NAME,
    workspaceSlug(workspacePath),
  );
}
