import { BrowserWindow } from "electron";
import log from "electron-log";

const logger = log.scope("workspace-window-manager");

const pathToWindow = new Map<string, BrowserWindow>();

function normalizeKey(pathOrUri: string): string {
  return pathOrUri.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

export function getWindowForWorkspaceKey(key: string): BrowserWindow | undefined {
  const win = pathToWindow.get(normalizeKey(key));
  if (win && !win.isDestroyed()) return win;
  if (win) pathToWindow.delete(normalizeKey(key));
  return undefined;
}

/** Windows we've already attached a cleanup listener to (bind is idempotent). */
const cleanupAttached = new WeakSet<BrowserWindow>();

export function registerWindowForWorkspace(
  key: string,
  win: BrowserWindow,
): void {
  const norm = normalizeKey(key);

  // Drop any workspace this window was previously bound to. Without this, a
  // window that switches projects stays reachable under its OLD path, so events
  // for the abandoned workspace keep arriving here — the cross-window leak in a
  // single window.
  for (const [existingKey, existingWin] of pathToWindow) {
    if (existingWin === win && existingKey !== norm) {
      pathToWindow.delete(existingKey);
    }
  }

  pathToWindow.set(norm, win);

  // Bind is now called by the renderer on every workspace open and reload, so the
  // listener must be attached exactly once per window or they accumulate until
  // Electron warns about a leak. The handler sweeps by identity, which also covers
  // the re-bind case above.
  if (!cleanupAttached.has(win)) {
    cleanupAttached.add(win);
    win.on("closed", () => {
      // Deleting the current entry mid-iteration is well-defined for a Map.
      for (const [existingKey, existingWin] of pathToWindow) {
        if (existingWin === win) pathToWindow.delete(existingKey);
      }
    });
  }
}

export function focusOrOpenWorkspaceWindow(
  key: string,
  createWindow: () => BrowserWindow,
): BrowserWindow {
  const existing = getWindowForWorkspaceKey(key);
  if (existing) {
    if (existing.isMinimized()) existing.restore();
    existing.focus();
    logger.log(`Focused existing window for ${key}`);
    return existing;
  }
  const win = createWindow();
  registerWindowForWorkspace(key, win);
  logger.log(`Created window for ${key}`);
  return win;
}

export function sendToWorkspaceWindow(
  key: string,
  channel: string,
  payload: unknown,
): boolean {
  const win = getWindowForWorkspaceKey(key);
  if (!win) return false;
  win.webContents.send(channel, payload);
  if (win.isMinimized()) win.restore();
  win.focus();
  return true;
}

/**
 * Deliver to one workspace's window WITHOUT stealing focus.
 *
 * `sendToWorkspaceWindow` restores and focuses — right for "open this thing for
 * the user", catastrophic for routine per-turn traffic (stream phases, permission
 * cards, plan updates), which would yank the window forward continuously.
 *
 * Returns false when the workspace has no bound window, so callers can fall back
 * to a broadcast rather than dropping the event. That fallback is what keeps this
 * strictly non-breaking: a window that has not yet bound behaves exactly as before.
 */
export function sendToWorkspaceWindowQuiet(
  key: string,
  channel: string,
  payload: unknown,
): boolean {
  const win = getWindowForWorkspaceKey(key);
  if (!win) return false;
  try {
    if (win.isDestroyed() || win.webContents.isDestroyed()) return false;
    win.webContents.send(channel, payload);
    return true;
  } catch {
    return false;
  }
}

/**
 * Name the window after the workspace it is showing.
 *
 * Every window previously inherited the same document title, so several open
 * projects were indistinguishable in the window list, the dock and Mission
 * Control. `setRepresentedFilename` additionally gives macOS the proxy icon and
 * path menu users expect from a document window.
 */
export function setWorkspaceWindowTitle(
  win: BrowserWindow,
  workspacePath: string,
): void {
  if (win.isDestroyed()) return;
  const name = workspacePath.replace(/[\\/]+$/, "").split(/[\\/]/).pop();
  try {
    win.setTitle(name ? `${name} — Atlarix` : "Atlarix");
    if (process.platform === "darwin") {
      win.setRepresentedFilename(workspacePath);
    }
  } catch {
    /* titling is cosmetic — never let it break window setup */
  }
}

export function getPrimaryWindow(): BrowserWindow | undefined {
  const focused = BrowserWindow.getFocusedWindow();
  if (focused && !focused.isDestroyed()) return focused;
  const all = BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed());
  return all[0];
}
