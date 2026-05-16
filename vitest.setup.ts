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
    },
    ipcMain,
    safeStorage: {
      isEncryptionAvailable: vi.fn(() => false),
      decryptString: vi.fn(),
      encryptString: vi.fn(),
    },
  };
});

vi.mock("@sentry/electron/main", () => ({
  init: vi.fn(),
  captureException: vi.fn(),
  addBreadcrumb: vi.fn(),
}));
