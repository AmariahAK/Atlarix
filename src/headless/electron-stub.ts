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
// `fromWebContents` / `fromId` likewise: the sub-agent `task` tool asks which
// window spawned it, and without them every sub-agent threw
// "BrowserWindow.fromWebContents is not a function" (owner, 2026-10-05). The CLI
// has no real window to name, and every caller already handles null.
export const BrowserWindow = {
  getAllWindows: () => (cliWindow ? [cliWindow] : []) as unknown[],
  getFocusedWindow: () => null,
  fromWebContents: () => null,
  fromId: () => null,
};

/**
 * The interactive CLI stands in for the app's window. Main-process code
 * broadcasts to every window (the mid-turn message queue, session titles,
 * background jobs); with no window those went nowhere. Batch runs attach none.
 * Reports itself focused, so nothing raises an OS notification for a terminal.
 */
let cliWindow: unknown = null;

/**
 * Every attached session hears every broadcast. The TUI attaches one; `atlarix
 * acp` attaches one per editor thread, and with a single slot the newest
 * session took every `permission-request` broadcast. Each session already drops
 * other chats' events by chatId. Returns the detach.
 */
const cliSenders = new Set<(channel: string, payload: unknown) => void>();

export function attachCliWindow(send: (channel: string, payload: unknown) => void): () => void {
  cliSenders.add(send);
  const detach = () => {
    cliSenders.delete(send);
    if (cliSenders.size === 0) cliWindow = null;
  };
  if (cliWindow) return detach;
  const webContents = {
    id: 1,
    isDestroyed: () => false,
    isCrashed: () => false,
    send: (channel: string, payload: unknown) => {
      for (const s of [...cliSenders]) s(channel, payload);
    },
  };
  cliWindow = {
    id: 1,
    webContents,
    isDestroyed: () => false,
    isFocused: () => true,
    isVisible: () => true,
    isMinimized: () => false,
    focus: noop,
    show: noop,
  };
  return detach;
}

interface SafeStorageImpl {
  isEncryptionAvailable(): boolean;
  encryptString(s: string): Buffer;
  decryptString(b: Buffer): string;
}

/** Batch runs: no OS encryption (secrets stay in their throwaway folder). */
let safeStorageImpl: SafeStorageImpl = {
  isEncryptionAvailable: () => false,
  encryptString: (s: string) => Buffer.from(s, "utf8"),
  decryptString: (b: Buffer) => b.toString("utf8"),
};

/**
 * The interactive CLI installs the desktop's own OS key here
 * (src/runtime/oscrypt.ts), so EVERY secret store — provider keys, the sign-in
 * session, MCP credentials — reads and writes what the desktop app does.
 */
export function setSafeStorageImpl(impl: SafeStorageImpl): void {
  safeStorageImpl = impl;
}

export const safeStorage = {
  isEncryptionAvailable: () => safeStorageImpl.isEncryptionAvailable(),
  encryptString: (s: string) => safeStorageImpl.encryptString(s),
  decryptString: (b: Buffer) => safeStorageImpl.decryptString(b),
};

export const dialog = {
  showErrorBox: noop,
  showMessageBox: async () => ({ response: 0 }),
  showOpenDialog: async () => ({ canceled: true, filePaths: [] as string[] }),
  showSaveDialog: async () => ({ canceled: true }),
};

export const shell = {
  // Under `atlarix acp` the editor opens it (an MCP server's sign-in page, say):
  // its extension watches stderr for this line, as it does for Atlarix's sign-in.
  openExternal: async (url?: string) => {
    if (process.env.ATLARIX_OPEN_URLS_VIA_STDERR === "1" && typeof url === "string" && /^https?:\/\//i.test(url)) {
      process.stderr.write(`Atlarix open: ${url}\n`);
    }
  },
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
