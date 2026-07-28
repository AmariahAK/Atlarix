import { vi } from "vitest";

/**
 * Vitest runs in Node, not Electron. Many main-process modules import `electron`
 * or `@sentry/electron/main`; stub them so importing those graphs does not throw.
 */
vi.mock("electron", () => {
  const app = {
    getPath: vi.fn((name: string) => `/tmp/atlarix-vitest/${String(name)}`),
  };
  const ipcMain = {
    handle: vi.fn(),
    on: vi.fn(),
    removeHandler: vi.fn(),
    removeListener: vi.fn(),
  };
  return {
    app,
    BrowserWindow: {
      getAllWindows: vi.fn(() => []),
      // `getPrimaryWindow()` (main/workspace-window-manager.ts) calls this on the
      // stream path, so omitting it threw
      // "BrowserWindow.getFocusedWindow is not a function" out of chat_stream
      // and surfaced to every agent-eval as "This model failed (...)" — 36 tests
      // across 23 eval files, none of them actually about windows.
      // Null is the honest answer with no windows open; the caller null-checks
      // and falls back to getAllWindows().
      getFocusedWindow: vi.fn(() => null),
    },
    ipcMain,
    safeStorage: {
      isEncryptionAvailable: vi.fn(() => false),
      decryptString: vi.fn(),
      encryptString: vi.fn(),
    },
    // Mirrors src/headless/electron-stub.ts so the keep-awake power blocker
    // (ActiveStreamRegistry.set → acquirePowerSaveBlocker) no-ops cleanly in
    // tests instead of logging a "No powerSaveBlocker export" warning.
    powerSaveBlocker: {
      start: vi.fn(() => 0),
      stop: vi.fn(),
      isStarted: vi.fn(() => false),
    },
  };
});

vi.mock("@sentry/electron/main", () => ({
  init: vi.fn(),
  captureException: vi.fn(),
  addBreadcrumb: vi.fn(),
}));
