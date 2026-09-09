/**
 * Pure, testable helpers for the auto-updater (no electron imports, so they can
 * be unit-tested in plain Node). The electron-wired side lives in `main.ts`.
 */

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
 * install. macOS additionally requires the app to live in /Applications.
 */
export function canElectronUpdaterRun(env: {
  platform: NodeJS.Platform;
  isPackaged: boolean;
  isAppImage: boolean;
  isInApplicationsFolder: boolean;
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
  if (env.platform === "linux" && !env.isAppImage) {
    return {
      ok: false,
      reason: "unsupported",
      detail:
        "deb/rpm packages update via your package manager — download the latest from the releases page.",
    };
  }
  return { ok: true };
}
