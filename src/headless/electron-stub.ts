/**
 * Headless (Electron-free) stub of the `electron` module.
 *
 * `scripts/build-headless.mjs` aliases `electron` → this file at build time so
 * the real `chat:stream` agent loop runs in plain Node (inside a Terminal-Bench
 * container, or any CI). Mirrors the surface the main-process graph imports
 * (see `grep 'from "electron"' src`). Only `ipcMain.handle` does real work —
 * it records handlers so the headless runner can fetch `chat:stream` /
 * `execute-permission`; everything else is an inert no-op.
 */
import os from "node:os";
import path from "node:path";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Handler = (event: any, ...args: any[]) => unknown;
const handlers = new Map<string, Handler>();

export const ipcMain = {
  handle(channel: string, fn: Handler) {
    handlers.set(channel, fn);
  },
  on() {},
  removeHandler(channel: string) {
    handlers.delete(channel);
  },
  removeListener() {},
};

/** Fetch a handler registered via `ipcMain.handle` (used by the headless runner). */
export function getRegisteredHandler(channel: string): Handler | undefined {
  return handlers.get(channel);
}

const userDataBase =
  process.env.ATLARIX_USER_DATA_DIR ??
  path.join(os.tmpdir(), "atlarix-headless");

const noop = () => {};

export const app = {
  getPath: (name: string) =>
    name === "userData" ? userDataBase : path.join(userDataBase, String(name)),
  getName: () => "Atlarix",
  getVersion: () => process.env.ATLARIX_VERSION ?? "0.0.0-headless",
  getAppPath: () => process.cwd(),
  on: noop,
  whenReady: async () => {},
  quit: noop,
  setName: noop,
  requestSingleInstanceLock: () => true,
  commandLine: { appendSwitch: noop },
};

// `getFocusedWindow` is required as well as `getAllWindows`: `getPrimaryWindow()`
// (main/workspace-window-manager.ts) calls it on the chat-stream path, and a
// missing function throws rather than degrading — which is how it reached the
// model as "This model failed (...)" instead of a window warning.
export const BrowserWindow = {
  getAllWindows: () => [] as unknown[],
  getFocusedWindow: () => null,
};

export const safeStorage = {
  isEncryptionAvailable: () => false,
  encryptString: (s: string) => Buffer.from(s, "utf8"),
  decryptString: (b: Buffer) => b.toString("utf8"),
};

export const dialog = {
  showErrorBox: noop,
  showMessageBox: async () => ({ response: 0 }),
  showOpenDialog: async () => ({ canceled: true, filePaths: [] as string[] }),
  showSaveDialog: async () => ({ canceled: true }),
};

export const shell = {
  openExternal: async () => {},
  openPath: async () => "",
  showItemInFolder: noop,
  trashItem: async () => {},
};

export const clipboard = { readText: () => "", writeText: noop };
export const nativeTheme = {
  shouldUseDarkColors: false,
  on: noop,
  themeSource: "system",
};
export const powerMonitor = { on: noop };
export const powerSaveBlocker = {
  start: () => 0,
  stop: noop,
  isStarted: () => false,
};
export const session = {
  defaultSession: {
    webRequest: { onBeforeRequest: noop },
    setProxy: async () => {},
  },
};
export const Menu = {
  buildFromTemplate: () => ({ popup: noop }),
  setApplicationMenu: noop,
};
export class Notification {
  show() {}
  on() {}
}
export const contextBridge = { exposeInMainWorld: noop };
export const ipcRenderer = {
  invoke: async () => undefined,
  on: noop,
  send: noop,
  removeListener: noop,
};
export const webFrame = { setZoomFactor: noop };
export class WebContentsView {
  webContents = { loadURL: async () => {}, on: noop };
}

export default {
  app,
  BrowserWindow,
  ipcMain,
  safeStorage,
  dialog,
  shell,
  clipboard,
  nativeTheme,
  powerMonitor,
  powerSaveBlocker,
  session,
  Menu,
  Notification,
  contextBridge,
  ipcRenderer,
  webFrame,
  WebContentsView,
  getRegisteredHandler,
};
