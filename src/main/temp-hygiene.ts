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

/**
 * Which Atlarix processes are running right now: one file per process,
 * `<pid>.json`, written at start and removed at exit. Never swept itself.
 *
 * WHY. The app, the CLI, an editor's ACP process (our VS Code panel included)
 * and headless runs all share `atlarix-scratch` and `atlarix-attachments`, and
 * only the app used to clean. So the terminal and editors left their temp files
 * to the OS (never cleaned on Windows), and quitting the app deleted the scratch
 * directory of a CLI session still working in it. Each process now holds a
 * lease, and a directory another live process may be using is left alone.
 *
 * A process that died without removing its file (kill -9, a crash) is found by
 * its pid no longer running, and its file is removed. A reused pid reads as
 * alive, which only means keeping files longer: the safe direction.
 */
const LEASES_DIR_NAME = `${ATLARIX_TEMP_PREFIX}leases`;
/** While another Atlarix runs, a directory younger than this may be its. */
const OTHER_HOLDER_MIN_AGE_MS = 60 * 60 * 1000;

function leasesDir(): string {
  return path.join(os.tmpdir(), LEASES_DIR_NAME);
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM: running, as another user. Anything else (ESRCH): gone.
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

let leasePath: string | null = null;

/** This process may be using the shared temp directories, until it exits. */
export function registerTempLease(surface: string): void {
  if (leasePath) return;
  try {
    fs.mkdirSync(leasesDir(), { recursive: true });
    const p = path.join(leasesDir(), `${process.pid}.json`);
    fs.writeFileSync(p, JSON.stringify({ pid: process.pid, surface, since: Date.now() }));
    leasePath = p;
    process.once("exit", releaseTempLease);
  } catch (e) {
    logger.warn(`could not write temp lease: ${String(e)}`);
  }
}

export function releaseTempLease(): void {
  if (!leasePath) return;
  try {
    fs.rmSync(leasePath, { force: true });
  } catch {
    /* the file goes stale and the next sweep removes it */
  }
  leasePath = null;
}

/** How many OTHER Atlarix processes are running; ended ones' files are removed. */
async function otherLiveHolders(): Promise<number> {
  let names: string[];
  try {
    names = await fsp.readdir(leasesDir());
  } catch {
    return 0;
  }
  let live = 0;
  for (const name of names) {
    const m = /^(\d+)\.json$/.exec(name);
    if (!m) continue;
    const pid = Number(m[1]);
    if (pid === process.pid) continue;
    if (isAlive(pid)) live++;
    else await fsp.rm(path.join(leasesDir(), name), { force: true }).catch(() => {});
  }
  return live;
}

export type SweepOptions = {
  /**
   * Include the directories this process holds open. True only at quit, when
   * nothing of ours is still writing.
   */
  includeLive: boolean;
};

async function sweepTempDirs(opts: SweepOptions): Promise<number> {
  const root = os.tmpdir();
  const others = await otherLiveHolders();
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
    if (entry.name === LEASES_DIR_NAME) continue;
    // Shared by every running Atlarix: taken only at exit, and only by the last.
    if (LIVE_WHILE_RUNNING.has(entry.name) && (!opts.includeLive || others > 0)) continue;

    const full = path.join(root, entry.name);
    try {
      if (entry.name.startsWith(OTHER_PROCESS_PREFIX)) {
        const stat = await fsp.stat(full);
        if (Date.now() - stat.mtimeMs < OTHER_PROCESS_MIN_AGE_MS) continue;
      } else if (others > 0 && !LIVE_WHILE_RUNNING.has(entry.name)) {
        // Another Atlarix is running and may have made this a moment ago.
        const stat = await fsp.stat(full);
        if (Date.now() - stat.mtimeMs < OTHER_HOLDER_MIN_AGE_MS) continue;
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
  // This process is done with them; another one still running keeps them.
  releaseTempLease();
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

/**
 * Everything a process does at start: hold a lease, take what a previous run
 * left, and keep a slow timer. Every surface calls it (app, CLI, ACP), and
 * `sweepTempOnQuit` at its exit.
 */
export function startTempHygiene(surface: string): void {
  registerTempLease(surface);
  scheduleStartupTempSweep();
  startPeriodicTempSweep();
}

/** Exported for tests — the predicate is the whole safety argument. */
export const __testing = { sweepTempDirs, LIVE_WHILE_RUNNING, LEASES_DIR_NAME, otherLiveHolders };
