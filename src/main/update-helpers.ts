/**
 * Pure, testable helpers for the auto-updater (no electron imports, so they can
 * be unit-tested in plain Node). The electron-wired side lives in `main.ts`.
 */

import fs from "node:fs";
import path from "node:path";

export type LinuxPackageType = "deb" | "rpm";

/**
 * How this Linux install was packaged, from `resources/package-type`: the
 * file electron-updater itself reads to pick DebUpdater or RpmUpdater. The
 * deb and rpm write it on install (forge.config.ts); an AppImage has none.
 */
export function readLinuxPackageType(
  resourcesPath: string,
  read: (file: string) => string = (file) => fs.readFileSync(file, "utf8"),
): LinuxPackageType | null {
  try {
    const kind = read(path.join(resourcesPath, "package-type")).trim();
    return kind === "deb" || kind === "rpm" ? kind : null;
  } catch {
    return null;
  }
}

export type UpdateResult =
  | "idle"
  | "checking"
  | "up-to-date"
  | "available"
  | "downloading"
  | "downloaded"
  | "error"
  | "unsupported";

export interface UpdateStatus {
  /** The running app version. */
  currentVersion: string;
  /** Epoch ms of the last completed check, or null if none yet. */
  lastCheckAt: number | null;
  /** The latest known result of the update flow. */
  lastResult: UpdateResult;
  /** Human-readable detail (error message, "Move to /Applications", etc.). */
  detail?: string;
  /** Newest available version, when known. */
  availableVersion?: string;
}

/** Semver-ish "a is strictly newer than b" over the first three numeric parts. */
export function isNewer(a: string, b: string): boolean {
  const pa = a.split(".").map((n) => Number(n));
  const pb = b.split(".").map((n) => Number(n));
  for (let i = 0; i < 3; i++) {
    const x = Number.isFinite(pa[i]) ? (pa[i] as number) : 0;
    const y = Number.isFinite(pb[i]) ? (pb[i] as number) : 0;
    if (x !== y) return x > y;
  }
  return false;
}

/**
 * Should the notify-only GitHub-release check run?
 *
 * It exists as a BRIDGE for installs that electron-updater cannot silently
 * update — Linux deb/rpm, macOS not in /Applications, or a feed-setup failure.
 * When electron-updater IS active for this install it would only double-fire a
 * confusing "go download from GitHub" banner alongside the silent download, so
 * we suppress it. Dev (unpackaged) builds never check.
 *
 * A Microsoft Store (MSIX) install suppresses it too. Store apps are updated by
 * the Store, so the bridge has nothing to bridge to — it would just nag the user
 * to go hand-install a build from GitHub, which for a Store install is a
 * downgrade in every sense.
 */
export function shouldRunNotifyOnlyCheck(env: {
  isPackaged: boolean;
  electronUpdaterActive: boolean;
  /** `process.windowsStore` — true only for an MSIX/appx (Store) install. */
  isWindowsStore?: boolean;
}): boolean {
  if (!env.isPackaged) return false;
  if (env.isWindowsStore) return false;
  return !env.electronUpdaterActive;
}

/**
 * Which updater mechanism to use for this install.
 *
 * Windows ships Squirrel.Windows installers (electron-forge `MakerSquirrel`),
 * which electron-updater does NOT support (it only handles electron-builder's
 * NSIS). So Windows uses Electron's built-in `autoUpdater` via
 * `update-electron-app` / update.electronjs.org (the Squirrel-native path).
 * macOS + Linux stay on electron-updater, gated by `canElectronUpdaterRun`.
 *
 * A Microsoft Store (MSIX) install is `"none"`, and that check must come BEFORE
 * the win32 branch. An MSIX install is packaged win32, so it would otherwise be
 * handed to Squirrel — which would try to write into
 * `C:\Program Files\WindowsApps\…`, a READ-ONLY location. Store apps update
 * through the Store; there is nothing for a bundled updater to do.
 *
 * - `"squirrel"`   → Windows (packaged, non-Store): built-in autoUpdater + update-electron-app.
 * - `"electron-updater"` → mac (in /Applications) / Linux AppImage.
 * - `"none"`       → unpackaged, Microsoft Store (MSIX), or an install
 *                    electron-updater can't drive (deb/rpm, mac outside
 *                    /Applications) — the notify-only bridge handles the last group.
 */
export function chooseUpdaterKind(env: {
  platform: NodeJS.Platform;
  isPackaged: boolean;
  isAppImage: boolean;
  isInApplicationsFolder: boolean;
  linuxPackageType?: LinuxPackageType | null;
  /** `process.windowsStore` — true only for an MSIX/appx (Store) install. */
  isWindowsStore?: boolean;
}): "squirrel" | "electron-updater" | "none" {
  if (!env.isPackaged) return "none";
  if (env.isWindowsStore) return "none";
  if (env.platform === "win32") return "squirrel";
  return canElectronUpdaterRun(env).ok ? "electron-updater" : "none";
}

/**
 * Whether electron-updater can drive a true silent background update for this
 * install. macOS additionally requires the app to live in /Applications; on
 * Linux an AppImage, deb or rpm can (a deb/rpm installs through the system's
 * password prompt). Anything else gets the notify-only bridge.
 */
export function canElectronUpdaterRun(env: {
  platform: NodeJS.Platform;
  isPackaged: boolean;
  isAppImage: boolean;
  isInApplicationsFolder: boolean;
  /** deb/rpm update through electron-updater's DebUpdater/RpmUpdater. */
  linuxPackageType?: LinuxPackageType | null;
}): { ok: boolean; reason?: UpdateResult; detail?: string } {
  if (!env.isPackaged)
    return { ok: false, reason: "idle", detail: "Development build" };
  if (env.platform === "darwin" && !env.isInApplicationsFolder) {
    return {
      ok: false,
      reason: "unsupported",
      detail: "Move Atlarix to /Applications to enable automatic updates.",
    };
  }
  if (env.platform === "linux" && !env.isAppImage && !env.linuxPackageType) {
    return {
      ok: false,
      reason: "unsupported",
      detail: "This install can't update itself. Download the latest from the releases page.",
    };
  }
  return { ok: true };
}

/**
 * The "Move to Applications Folder?" dialog. When an Atlarix is already in
 * Applications, moving replaces it (Electron sends it to the Trash), and the
 * default button used to be Move with nothing saying so: a test build launched
 * on a fresh profile replaced the installed app on one Enter (2026-10-13). Say
 * what goes to the Trash, and make keeping it the default.
 */
export function moveToApplicationsDialog(existing: {
  name: string;
  version: string | null;
} | null): {
  message: string;
  detail?: string;
  buttons: [string, string];
  defaultId: 0 | 1;
} {
  const buttons: [string, string] = [
    "Move to Applications Folder",
    "Do Not Move",
  ];
  if (!existing) {
    return {
      message: "Move to Applications Folder? (required for auto-update)",
      buttons,
      defaultId: 0,
    };
  }
  const which = existing.version
    ? `${existing.name} ${existing.version}`
    : existing.name;
  return {
    message: "Move to Applications Folder? (required for auto-update)",
    detail: `${which} is already in Applications. Moving replaces it, and it goes to the Trash.`,
    buttons,
    defaultId: 1,
  };
}

/**
 * Whether a window can still be sent to. While the app quits, the window is
 * destroyed first, and then even READING its `webContents` throws "Object has
 * been destroyed": an update install failing on quit (Fedora with pkexec but no
 * polkit agent) reported its error that way and crashed with an unhandled
 * TypeError instead (15.11.1 container run). Check the window, then its page.
 */
export function windowAlive<W extends { isDestroyed(): boolean; webContents: { isDestroyed(): boolean } }>(
  win: W | null | undefined,
): win is W {
  return !!win && !win.isDestroyed() && !win.webContents.isDestroyed();
}

/** The re-check cadence while updates are working (long-running sessions). */
export const UPDATE_RECHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;
/** The first re-check after a failure; each failure in a row doubles it, up to the cadence. */
export const UPDATE_RETRY_FIRST_MS = 2 * 60 * 1000;

/** How long until the next check, after `failuresInARow` failed ones (0 = the last one worked). */
export function nextUpdateCheckDelayMs(failuresInARow: number): number {
  if (failuresInARow <= 0) return UPDATE_RECHECK_INTERVAL_MS;
  return Math.min(
    UPDATE_RETRY_FIRST_MS * 2 ** (failuresInARow - 1),
    UPDATE_RECHECK_INTERVAL_MS,
  );
}

/**
 * When electron-updater checks again. A download that died at 17% on a network
 * change waited the full 4 h for the next check (owner's Mac, 2026-10-26): now
 * a failure (check, download or install) re-checks after 2 min, doubling up to
 * 4 h, and a good result goes back to every 4 h. A check is always pending, so
 * one whose result never arrives is retried on the same clock.
 */
export function createUpdateRechecker(
  check: () => void,
  timers: {
    set: (fn: () => void, ms: number) => unknown;
    clear: (t: unknown) => void;
  } = {
    set: (fn, ms) => setTimeout(fn, ms),
    clear: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
  },
) {
  let failures = 0;
  let timer: unknown = null;
  const schedule = (): number => {
    if (timer != null) timers.clear(timer);
    const ms = nextUpdateCheckDelayMs(failures);
    timer = timers.set(() => {
      schedule();
      check();
    }, ms);
    return ms;
  };
  return {
    /** Start the clock (the first check is made by the caller). */
    start: schedule,
    /** A check, download or install failed: returns the wait before the retry. */
    failed: (): number => {
      failures++;
      return schedule();
    },
    /** Up to date, or an update is downloaded. */
    succeeded: (): number => {
      failures = 0;
      return schedule();
    },
    stop: (): void => {
      if (timer != null) timers.clear(timer);
      timer = null;
    },
  };
}
