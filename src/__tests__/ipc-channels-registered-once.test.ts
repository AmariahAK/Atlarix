/**
 * No IPC channel is registered twice.
 *
 * WHY THIS EXISTS
 * ---------------
 * Electron's real `ipcMain.handle` THROWS on a duplicate:
 * `Error: Attempted to register a second handler for 'auth:check-workspace-limit'`
 * (that channel is gone as of 2026-09-08; the failure mode is not)
 * — thrown during module load, before any window exists, so the app dies at
 * launch with a JavaScript-error dialog and nothing else.
 *
 * Nothing in the suite could catch that, because every test mocks `ipcMain` with
 * `handle: vi.fn()`, which accepts duplicates happily. So a whole green run —
 * 316 files, 2574 tests, tsc and oxlint clean — sat on top of an app that could
 * not start, and the first thing that noticed was the packaged build.
 *
 * That is the gap this closes: assert the property the mock cannot, against the
 * real registrar list.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const handled: string[] = [];

vi.mock("electron", () => {
  const handle = (channel: string) => {
    handled.push(channel);
  };
  return {
    ipcMain: { handle, on: vi.fn(), removeHandler: vi.fn() },
    app: {
      getPath: (n: string) => `/tmp/atlarix-ipc-dupe-test/${n}`,
      getName: () => "Atlarix",
      getVersion: () => "0.0.0-test",
      on: vi.fn(),
      whenReady: () => Promise.resolve(),
    },
    BrowserWindow: Object.assign(
      function () {
        return {};
      },
      { getAllWindows: () => [], getFocusedWindow: () => null },
    ),
    shell: { openExternal: vi.fn() },
    dialog: { showOpenDialog: vi.fn(), showMessageBox: vi.fn() },
    safeStorage: {
      isEncryptionAvailable: () => false,
      encryptString: (s: string) => Buffer.from(s),
      decryptString: (b: Buffer) => b.toString(),
    },
    nativeTheme: { on: vi.fn() },
    session: { defaultSession: { webRequest: { onHeadersReceived: vi.fn() } } },
  };
});

beforeEach(() => {
  handled.length = 0;
});

describe("IPC channel registration", () => {
  it("registers `auth:get-plan-info` exactly once", async () => {
    // The original regression was on `auth:check-workspace-limit`: an edit to
    // auth_handlers.ts duplicated the block and the app crashed on launch with
    // "Attempted to register a second handler". That channel was deleted on
    // 2026-09-08 with the workspace cap, so this now names a live channel from the
    // same file — the property being guarded is the file's, not that channel's.
    const { registerAuthHandlers } = await import("@/ipc/handlers/auth_handlers");
    registerAuthHandlers();
    const dupes = handled.filter((c) => c === "auth:get-plan-info");
    expect(dupes).toHaveLength(1);
  });

  it("registers every auth channel exactly once", async () => {
    const { registerAuthHandlers } = await import("@/ipc/handlers/auth_handlers");
    registerAuthHandlers();
    const seen = new Map<string, number>();
    for (const c of handled) seen.set(c, (seen.get(c) ?? 0) + 1);
    const duplicated = [...seen.entries()].filter(([, n]) => n > 1);
    // Report WHICH channel, not just that something is wrong — the crash dialog
    // names one, and so should this.
    expect(duplicated.map(([c, n]) => `${c} ×${n}`)).toEqual([]);
  });

  it("still registers the channels the renderer depends on", async () => {
    // A guard that only counts duplicates would pass on an empty list.
    const { registerAuthHandlers } = await import("@/ipc/handlers/auth_handlers");
    registerAuthHandlers();
    expect(handled).toContain("auth:sign-out");
    expect(handled).toContain("auth:get-plan-info");
    expect(handled).toContain("auth:get-current-user");
  });

  it("does NOT register the deleted workspace-limit enforcer", async () => {
    const { registerAuthHandlers } = await import("@/ipc/handlers/auth_handlers");
    registerAuthHandlers();
    expect(handled).not.toContain("auth:enforce-workspace-limit");
  });
});
