import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { vi } from "vitest";
import { setAgentMemoryRootOverride } from "@/lib/agent-memory";

/**
 * Agent memory NEVER points at the developer's real `~/.atlarix` during tests.
 *
 * `memoryDirFor()` derives its directory from the workspace path, and PermissionInterceptor
 * used to create that directory eagerly for every workspace it saw — so temp workspaces
 * (`mkdtempSync(".../atlarix-grant-XXXXXX")`) minted a real directory in the developer's
 * home on every run. The result was 435 empty `…atlarix-grant-…` project directories,
 * which made the project count meaningless and wrote into a user's home from a test run.
 *
 * The eager mkdir is gone, but this override is the structural guarantee: set once for
 * every file in the node project, so a future test cannot reintroduce the leak by
 * exercising a code path that writes a note. Individual suites may still override it.
 */
setAgentMemoryRootOverride(
  fs.mkdtempSync(path.join(os.tmpdir(), "atlarix-vitest-memory-")),
);

/**
 * Tests NEVER write to the app's real log file.
 *
 * electron-log resolves its file transport to the OS log directory
 * (`~/Library/Logs/Atlarix/main.log` on macOS) — the SAME file the packaged app
 * writes to. Every suite that touches a main-process module logs there, and the
 * volume is enough to rotate real history away in minutes: on 2026-08-05 both
 * `main.log` and `main.old.log` contained nothing but that day's test output
 * (`chat -1`, a `"subscription lookup exploded"` fixture), which destroyed the
 * diagnostic record of a live user-reported credential-loss bug at exactly the
 * moment it was being investigated.
 *
 * Same class as the agent-memory leak above, with a worse failure mode: that one
 * created junk, this one deletes evidence. Console output is untouched, so a
 * failing test still says why.
 */
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const electronLog = require("electron-log") as {
    transports?: { file?: { level?: unknown } };
  };
  if (electronLog?.transports?.file) {
    electronLog.transports.file.level = false;
  }
} catch {
  /* electron-log not resolvable in this project — nothing to silence */
}

/**
 * Vitest runs in Node, not Electron. Many main-process modules import `electron`
 * or `@sentry/electron/main`; stub them so importing those graphs does not throw.
 */
vi.mock("electron", () => {
  const app = {
    getPath: vi.fn((name: string) => `/tmp/atlarix-vitest/${String(name)}`),
    // Anything that reports the environment it ran in needs these — the
    // diagnostics report stamps version/platform/packaged onto every run. Without
    // them the failure is "app.getVersion is not a function" from deep inside
    // unrelated code, which is the same shape as the getFocusedWindow story below.
    getVersion: vi.fn(() => "0.0.0-test"),
    isPackaged: false,
    exit: vi.fn(),
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
