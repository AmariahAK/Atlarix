/**
 * One-time cleanup of orphaned index directories left behind by the v14.9.0
 * retrieval teardown.
 *
 * The teardown deleted the FTS5/ctags/blueprint *code* but never removed the
 * on-disk directories those writers had already created. Every user who upgraded
 * from a pre-14.9.0 build therefore carries ~1.4 GB of dead index data in their
 * userData forever (fts5-index ~1.1 GB, ctags-index ~267 MB, plus stale
 * blueprints / diagram-git). No live code references these dirs anymore, so this
 * removal is safe.
 *
 * Runs once, guarded by a marker file. Fire-and-forget from onReady — never
 * blocks startup.
 */
import fs from "node:fs/promises";
import type { Dirent } from "node:fs";
import path from "node:path";
import log from "electron-log";
import { getUserDataPath } from "../../paths/paths";

/** Bump the suffix if a future teardown orphans another set of dirs. */
const MARKER_FILE = ".legacy-index-cleanup-v1";

/**
 * Orphaned directory names under userData. These were written by the removed
 * FTS5 indexer, ctags indexer, blueprint builder, and diagram-git store.
 */
const LEGACY_INDEX_DIRS = [
  "fts5-index",
  "ctags-index",
  "blueprints",
  "diagram-git",
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
 * Delete the orphaned legacy index dirs once. Idempotent: after a successful run
 * the marker file short-circuits every subsequent launch.
 */
export async function cleanupLegacyIndexDirs(): Promise<void> {
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
  for (const name of LEGACY_INDEX_DIRS) {
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
      log.warn(`[legacy-index-cleanup] failed to remove ${name}:`, err);
    }
  }

  try {
    await fs.writeFile(markerPath, new Date().toISOString(), "utf8");
  } catch (err) {
    // If the marker can't be written we'd re-run next launch — harmless (the
    // dirs are already gone, so it's a fast no-op walk). Just log.
    log.warn("[legacy-index-cleanup] could not write marker:", err);
  }

  if (removed.length > 0) {
    log.info(
      `[legacy-index-cleanup] reclaimed ${(reclaimed / 1e6).toFixed(0)} MB: ${removed.join(", ")}`,
    );
  }
}
