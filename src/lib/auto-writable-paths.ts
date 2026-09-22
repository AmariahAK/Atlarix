import os from "node:os";
import path from "node:path";

/**
 * Locations the agent may write WITHOUT an approval card, even though they sit
 * outside the workspace.
 *
 * Both are places the harness itself told the agent to use. The runtime identity
 * block publishes the memory directory ("read and write notes there and nowhere
 * else") and the scratch directory ("temp files go here, not /tmp"), and then
 * the approval gate asked about every single write to them. A prompt that
 * instructs and a gate that interrogates the result is the harness arguing with
 * itself, and the cost lands on the user as a card per note.
 *
 * CONTAINMENT, NEVER SUBSTRING. This is the whole reason the file exists rather
 * than a regex somewhere. The previous blanket allowance matched on the
 * substring `/.atlarix/`, so `../other-repo/.atlarix/hooks/hooks.json` matched
 * too — silent write access to ANOTHER project's agent config and hooks. Every
 * check here resolves both paths and asks `path.relative` whether the result
 * escapes, so a sibling directory, a `..` traversal, and a path that merely
 * shares a name prefix all fail.
 *
 * The memory root is per-workspace (`~/.atlarix/projects/<slug>/memory`), so one
 * project's turn still cannot reach another project's notes.
 */

/** True when `abs` is `root` or lives beneath it. Prefix-safe, traversal-safe. */
function isWithin(root: string, abs: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(abs));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * The OS temp roots.
 *
 * `os.tmpdir()` alone is not enough on macOS: it returns the per-user
 * `/var/folders/…`, while a model writing "to /tmp" means `/tmp` — which is a
 * symlink to `/private/tmp`, so both spellings have to be here or the exemption
 * misses the exact case it is for.
 */
export function tempRoots(): string[] {
  return [os.tmpdir(), "/tmp", "/private/tmp", "/var/folders"];
}

/** Is this an OS temp path? */
export function isTempPath(abs: string): boolean {
  return tempRoots().some((root) => isWithin(root, abs));
}

/**
 * Auto-writable: this workspace's own memory or scratch directory.
 *
 * NOT the whole temp root. Granting `os.tmpdir()` was the first attempt and the
 * suite caught it at once: its workspaces live under the temp root, so "outside
 * the workspace" stopped meaning anything. On macOS that root is
 * `/var/folders` — every app's cache, not a scratch area.
 *
 * Both roots are passed in rather than derived, so the CALLER decides which
 * workspace is in play. Deriving them here would invite a future caller to pass
 * the wrong workspace and quietly widen the grant.
 */
export function isAutoWritablePath(
  abs: string,
  memoryDir?: string | null,
  scratchDir?: string | null,
): boolean {
  if (!abs || !path.isAbsolute(abs)) return false;
  if (memoryDir && isWithin(memoryDir, abs)) return true;
  return Boolean(scratchDir && isWithin(scratchDir, abs));
}
