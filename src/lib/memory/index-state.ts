/**
 * What each session last knew of its project's MEMORY.md.
 *
 * The change notice (`session-context.ts`) compares the index on disk with the one
 * the session was last shown. That baseline is derived from the session's own
 * persisted rows, so it survives a restart; this map only adds what the rows cannot
 * hold — the session's OWN `edit_file` writes to the index, recorded as they land,
 * so the agent is never told "MEMORY.md changed" about an edit it just made.
 *
 * Deliberately dependency-free: `file-read-log.ts` calls it on every write.
 */

import path from "node:path";

const known = new Map<string, { indexPath: string; text: string }>();

/** True for `<root>/projects/<slug>/memory/MEMORY.md`, the only index shape. */
function isMemoryIndexPath(filePath: string): boolean {
  if (!path.isAbsolute(filePath)) return false;
  const dir = path.dirname(filePath);
  return (
    path.basename(filePath) === "MEMORY.md" &&
    path.basename(dir) === "memory" &&
    path.basename(path.dirname(path.dirname(dir))) === "projects"
  );
}

/** Record a write that landed; ignores every path that is not a memory index. */
export function noteMemoryIndexWrite(
  scope: string | null,
  filePath: string,
  content: string,
): void {
  if (!scope || !isMemoryIndexPath(filePath)) return;
  known.set(scope, { indexPath: path.resolve(filePath), text: content });
}

/** Record what a session was just shown (an attached index or change notice). */
export function setKnownMemoryIndex(
  scope: string | null,
  indexPath: string,
  text: string,
): void {
  if (!scope) return;
  known.set(scope, { indexPath: path.resolve(indexPath), text });
}

/** The in-process baseline for this session and index, if any. */
export function getKnownMemoryIndex(
  scope: string | null,
  indexPath: string,
): string | undefined {
  if (!scope) return undefined;
  const k = known.get(scope);
  return k && k.indexPath === path.resolve(indexPath) ? k.text : undefined;
}

/** Test seam. */
export function __clearKnownMemoryIndexes(): void {
  known.clear();
}
