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

export function registerWindowForWorkspace(
  key: string,
  win: BrowserWindow,
): void {
  const norm = normalizeKey(key);
  pathToWindow.set(norm, win);
  win.on("closed", () => {
    if (pathToWindow.get(norm) === win) {
      pathToWindow.delete(norm);
    }
  });
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

export function getPrimaryWindow(): BrowserWindow | undefined {
  const focused = BrowserWindow.getFocusedWindow();
  if (focused && !focused.isDestroyed()) return focused;
  const all = BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed());
  return all[0];
}
