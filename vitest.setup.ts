// First: nothing may log to the app's real log file (tests/isolate-logs.ts).
import "./tests/isolate-logs";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, vi } from "vitest";
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
const VITEST_MEMORY_PREFIX = "atlarix-vitest-memory-";
const vitestMemoryRoot = fs.mkdtempSync(path.join(os.tmpdir(), VITEST_MEMORY_PREFIX));
setAgentMemoryRootOverride(vitestMemoryRoot);
// One per test file, every run: 3,418 were left in the temp folder by 2026-10-19.
afterAll(() => fs.rmSync(vitestMemoryRoot, { recursive: true, force: true }));
// A file whose tests never run (all skipped) gets no afterAll: its root is taken
// by a later run instead. Only this test-only prefix, and only an hour old, so a
// suite running in parallel keeps its own.
try {
  for (const name of fs.readdirSync(os.tmpdir())) {
    if (!name.startsWith(VITEST_MEMORY_PREFIX)) continue;
    const full = path.join(os.tmpdir(), name);
    if (Date.now() - fs.statSync(full).mtimeMs > 60 * 60 * 1000) {
      fs.rmSync(full, { recursive: true, force: true });
    }
  }
} catch {
  /* best effort */
}

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
 * failing test still says why. The file is also pointed at a temp folder
 * (tests/isolate-logs.ts, imported first), in case a test turns it back on.
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
 * The Core slot env vars are UNSET for every test, on CI as well as locally.
 *
 * `getCoreModelIdForCoreTier` resolves a slot in three steps: the runtime override
 * (hosted `core-models.json`), then `process.env.ATLARIX_CORE_MODEL_1..4`, then the
 * dev provider. Tests that exercise what happens to an UNMAPPED slot — the
 * fall-forward when a slot is dropped, the fall-back to the bare tier id, the route
 * that stays `compass` because nothing claims it — are really asserting on step two
 * being empty. That is true on a developer machine and false on CI, where the
 * workflow passes all four in as secrets at `env:` scope.
 *
 * So the suite went green locally and red on the release push, with the diagnosis
 * hidden twice over: the values arrive masked, so the failure reads
 * `expected '***' to be 'z-ai/glm-5.3'` — an assertion about a string nothing in the
 * repo produces. Three tests hit it at v14.45; individual suites had been patched
 * for the same reason at v14.7.
 *
 * DELETED, not `vi.stubEnv("", ...)`. A stub records the ambient value as the one to
 * restore, so the `vi.unstubAllEnvs()` in any suite that sets its own slots — and
 * three do — would hand the CI secret back to every test after it in that file.
 * Deleting makes "absent" the baseline those suites restore to, which is the state
 * they were all written against.
 */
for (const key of [
  "ATLARIX_CORE_MODEL_1",
  "ATLARIX_CORE_MODEL_2",
  "ATLARIX_CORE_MODEL_3",
  "ATLARIX_CORE_MODEL_4",
  "ATLARIX_CORE_MODEL_5",
]) {
  delete process.env[key];
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
      // Same class: the sub-agent `task` tool asks which window spawned it.
      fromWebContents: vi.fn(() => null),
      fromId: vi.fn(() => null),
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
