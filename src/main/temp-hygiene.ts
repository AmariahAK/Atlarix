import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import log from "electron-log";
import {
  AGENT_SCRATCH_ROOT_NAME,
  ATLARIX_TEMP_PREFIX,
} from "@/lib/agent-scratch";

const logger = log.scope("temp-hygiene");

/**
 * Remove Atlarix's own temp directories.
 *
 * WHAT WAS HAPPENING. `atlarix-attachments` is created at module load and
 * nothing has ever deleted it; the same is true of the scratch files the agent
 * writes, the CLI install staging dir and the headless user-data dirs. We relied
 * entirely on the operating system, which is fine on macOS (`/var/folders` is
 * pruned after a few days idle) and mostly fine on Linux (systemd-tmpfiles) —
 * and simply false on Windows, which never cleans `%TEMP%` unless the user has
 * turned Storage Sense on. We ship a Windows build, so on that platform this
 * accumulated indefinitely.
 *
 * THE RULE THAT MAKES THIS SAFE: only paths whose basename starts with
 * `atlarix-`, only directly under `os.tmpdir()`, and only real directories —
 * never a symlink, which is the one way a path we "own" could point somewhere we
 * do not. The agent writes to arbitrary places under `/tmp` that sit beside the
 * user's own files; a sweep that went near those would be one bad glob away from
 * deleting something irreplaceable. That is also why the agent is given a NAMED
 * scratch directory (`agent-scratch.ts`) — so its files land inside the prefix
 * instead of outside it.
 */

/**
 * Directories THIS process holds open for its whole lifetime.
 *
 * Only the quit sweep may take them. `atlarix-attachments` is created once at
 * module load (`chat_stream_handlers.ts`) and its path is captured in a const
 * for the session, so deleting it mid-run breaks the next attachment write with
 * a bare ENOENT — and an age gate would NOT protect it, because `mkdirSync` on
 * an existing directory does not refresh its mtime, so a dir inherited from a
 * previous run looks old while being actively used.
 */
const LIVE_WHILE_RUNNING = new Set([
  "atlarix-attachments",
  AGENT_SCRATCH_ROOT_NAME,
]);

/**
 * Directories another PROCESS may own.
 *
 * `requestSingleInstanceLock` guarantees no second desktop app — it says nothing
 * about a headless run, which is a separate process with its own temp dir and
 * can be mid-task while the desktop app opens or quits. Sweeping one of these
 * would destroy a live run's user data, so they are only ever taken once they
 * are old enough to be certainly dead.
 */
const OTHER_PROCESS_PREFIX = "atlarix-headless";
const OTHER_PROCESS_MIN_AGE_MS = 24 * 60 * 60 * 1000;

export type SweepOptions = {
  /**
   * Include the directories this process holds open. True only at quit, when
   * nothing of ours is still writing.
   */
  includeLive: boolean;
};

async function sweepTempDirs(opts: SweepOptions): Promise<number> {
  const root = os.tmpdir();
  let removed = 0;
  let entries: fs.Dirent[];
  try {
    entries = await fsp.readdir(root, { withFileTypes: true });
  } catch (e) {
    logger.warn(`could not read ${root}: ${String(e)}`);
    return 0;
  }

  for (const entry of entries) {
    if (!entry.name.startsWith(ATLARIX_TEMP_PREFIX)) continue;
    // A symlink named `atlarix-…` is not ours however much it looks like it.
    // `isDirectory()` is false for a symlink in a Dirent, so this also rejects
    // one pointing at a directory elsewhere.
    if (!entry.isDirectory()) continue;
    if (!opts.includeLive && LIVE_WHILE_RUNNING.has(entry.name)) continue;

    const full = path.join(root, entry.name);
    try {
      if (entry.name.startsWith(OTHER_PROCESS_PREFIX)) {
        const stat = await fsp.stat(full);
        if (Date.now() - stat.mtimeMs < OTHER_PROCESS_MIN_AGE_MS) continue;
      }
      await fsp.rm(full, { recursive: true, force: true });
      removed++;
    } catch (e) {
      // Never let hygiene cost the user a quit or a launch.
      logger.warn(`could not remove ${full}: ${String(e)}`);
    }
  }
  return removed;
}

/**
 * APP CLOSE — the pass that does the real work.
 *
 * Takes everything of ours including the directories held open all session,
 * because by quit time nothing of ours is still writing them.
 */
export async function sweepTempOnQuit(): Promise<void> {
  const removed = await sweepTempDirs({ includeLive: true });
  if (removed > 0) logger.info(`removed ${removed} temp director(ies) on quit`);
}

/**
 * APP OPEN — the remainder.
 *
 * Everything the close sweep did not get, because a close can be skipped for
 * reasons we do not control: a crash, a `kill -9`, a forced reboot, a quit that
 * threw. There is no age gate on this any more — anything here that is not held
 * open by this process or owned by another one is, by definition, left over from
 * a run that has ended.
 *
 * Deferred and fire-and-forget: the user is waiting for a window, not for this.
 */
export function scheduleStartupTempSweep(): void {
  setTimeout(() => {
    void sweepTempDirs({ includeLive: false })
      .then((removed) => {
        if (removed > 0) {
          logger.info(
            `removed ${removed} temp director(ies) left by a previous run`,
          );
        }
      })
      .catch((e) => logger.warn(`startup sweep failed: ${String(e)}`));
  }, 10_000).unref?.();
}

/**
 * THE TIMER — the backstop to the backstop.
 *
 * Close and open cover a normal lifecycle between them. This covers the case
 * neither does: an app left running for days, where the open sweep has already
 * happened and the close sweep has not happened yet. It applies the same rule as
 * open, so it can never touch what this session is using.
 */
export function startPeriodicTempSweep(
  intervalMs = 6 * 60 * 60 * 1000,
): NodeJS.Timeout {
  const t = setInterval(() => {
    void sweepTempDirs({ includeLive: false })
      .then((removed) => {
        if (removed > 0) logger.info(`removed ${removed} stale temp dir(s)`);
      })
      .catch((e) => logger.warn(`periodic sweep failed: ${String(e)}`));
  }, intervalMs);
  // Never hold the process open for hygiene.
  t.unref?.();
  return t;
}

/** Exported for tests — the predicate is the whole safety argument. */
export const __testing = { sweepTempDirs, LIVE_WHILE_RUNNING };
