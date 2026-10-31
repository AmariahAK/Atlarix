/**
 * Bun-only forced collection between agent steps (item 0q).
 *
 * The CLI is ONE long-lived Bun process (turn engine + transport + TUI). The
 * turn engine re-serializes the full growing native history on every step;
 * without a forced collection bmalloc grows to the turn's peak working set and
 * never returns it, so a long Build turn climbs toward multi-GB RSS and
 * thrashes an 8 GB Mac. Collecting synchronously between steps lets the
 * allocator reuse that memory instead of growing into it.
 *
 * No-op under Node/Electron: the desktop main process has its own GC cadence
 * and no `Bun` global, so this is safe to call from shared turn code.
 */
export function forceGcBetweenSteps(): void {
  if (!process.versions.bun) return;
  const bun = (globalThis as { Bun?: { gc?: (force?: boolean) => void } }).Bun;
  if (typeof bun?.gc === "function") bun.gc(true);
}
