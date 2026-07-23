/**
 * One-time cleanup of userData directories orphaned by feature teardowns.
 *
 * When a feature is removed we delete its *code*, but never the data its writers
 * had already put on disk — so every upgrading user carries it forever. Two
 * teardowns have done this:
 *
 * - **v14.9.0 retrieval teardown** — ~1.4 GB of dead index data (fts5-index
 *   ~1.1 GB, ctags-index ~267 MB, plus stale blueprints / diagram-git).
 * - **v14.16.0 session-recording removal** — `media/` held JPEG frames of the
 *   browser reel (~55 KB per action, up to 150 per turn).
 *
 * No live code references any of these directories, so removal is safe.
 *
 * Runs once, guarded by a marker file. Fire-and-forget from onReady — never
 * blocks startup.
 */
import fs from "node:fs/promises";
import type { Dirent } from "node:fs";
import path from "node:path";
import log from "electron-log";
import { getUserDataPath } from "../../paths/paths";

/**
 * Bump the suffix whenever a new teardown orphans another set of dirs — a NEW
 * marker name is what makes the pass re-run for users who already completed an
 * earlier one. (Reusing the old name would silently skip every upgrader, which
 * is most of them; the re-walk of already-deleted dirs is a fast no-op.)
 */
const MARKER_FILE = ".orphaned-userdata-cleanup-v2";

/**
 * Orphaned directory names under userData, written by the removed FTS5 indexer,
 * ctags indexer, blueprint builder, diagram-git store, and browser session reel.
 */
const ORPHANED_DIRS = [
  "fts5-index",
  "ctags-index",
  "blueprints",
  "diagram-git",
  "media",
] as const;

async function dirSizeBytes(dir: string): Promise<number> {
  let total = 0;
  let entries: Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    try {
      if (entry.isDirectory()) {
        total += await dirSizeBytes(full);
      } else if (entry.isFile()) {
        total += (await fs.stat(full)).size;
      }
    } catch {
      /* entry vanished mid-walk — ignore */
    }
  }
  return total;
}

/**
 * Delete the orphaned dirs once. Idempotent: after a successful run the marker
 * file short-circuits every subsequent launch.
 */
export async function cleanupOrphanedUserData(): Promise<void> {
  const userData = getUserDataPath();
  const markerPath = path.join(userData, MARKER_FILE);

  try {
    await fs.access(markerPath);
    return; // already cleaned on a prior launch
  } catch {
    /* marker absent — proceed */
  }

  let reclaimed = 0;
  const removed: string[] = [];
  for (const name of ORPHANED_DIRS) {
    const dir = path.join(userData, name);
    try {
      const size = await dirSizeBytes(dir);
      if (size === 0) {
        // Nothing there (fresh install or already gone) — still rm to be safe.
        await fs.rm(dir, { recursive: true, force: true });
        continue;
      }
      await fs.rm(dir, { recursive: true, force: true });
      reclaimed += size;
      removed.push(`${name} (${(size / 1e6).toFixed(0)} MB)`);
    } catch (err) {
      log.warn(`[orphaned-userdata-cleanup] failed to remove ${name}:`, err);
    }
  }

  try {
    await fs.writeFile(markerPath, new Date().toISOString(), "utf8");
  } catch (err) {
    // If the marker can't be written we'd re-run next launch — harmless (the
    // dirs are already gone, so it's a fast no-op walk). Just log.
    log.warn("[orphaned-userdata-cleanup] could not write marker:", err);
  }

  if (removed.length > 0) {
    log.info(
      `[orphaned-userdata-cleanup] reclaimed ${(reclaimed / 1e6).toFixed(0)} MB: ${removed.join(", ")}`,
    );
  }
}
