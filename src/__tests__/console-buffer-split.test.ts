/**
 * Console and network entries share one record path but NOT one buffer.
 *
 * Before the Console tab they shared a single 50-entry array. Once ordinary
 * `log`/`info` output is captured, that arrangement would evict a recorded 500
 * within seconds of a chatty page loading — the tab would silently stop showing
 * the thing it exists for. These tests pin the split, the caps, and the IPC
 * coalescing that keeps a noisy page from flooding the renderer.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const sent: Array<{ channel: string; payload: unknown }> = [];

vi.mock("@/ipc/utils/safe_sender", () => ({
  safeSend: (_wc: unknown, channel: string, payload: unknown) => {
    sent.push({ channel, payload });
  },
}));
vi.mock("./safe_sender", () => ({
  safeSend: (_wc: unknown, channel: string, payload: unknown) => {
    sent.push({ channel, payload });
  },
}));

vi.mock("electron", () => ({
  WebContentsView: class {},
  session: {
    fromPartition: () => ({
      setPermissionRequestHandler() {},
      on() {},
      webRequest: { onCompleted() {} },
    }),
  },
  BrowserWindow: {
    fromId: () => null,
    getFocusedWindow: () => null,
    getAllWindows: () => [],
  },
}));

import {
  browserScopeForWindow,
  clearBrowserSurfaceErrors,
  getBrowserConsoleEntries,
  getBrowserSurfaceErrors,
  getBrowserSurfaceNetworkFailures,
  pushBrowserSurfaceError,
  type BrowserScope,
  type BrowserSurfaceError,
} from "@/ipc/utils/browser_view_manager";

let windowSeq = 0;
function makeScope(): BrowserScope {
  windowSeq += 1;
  const win = {
    id: windowSeq,
    isDestroyed: () => false,
    contentView: { children: [], addChildView() {}, removeChildView() {} },
    webContents: { isDestroyed: () => false, send() {} },
    getContentBounds: () => ({ x: 0, y: 0, width: 1600, height: 900 }),
    once() {},
  };
  return browserScopeForWindow(win as never);
}

function consoleEntry(
  level: BrowserSurfaceError["level"],
  message: string,
): BrowserSurfaceError {
  return { type: "console-error", level, message, timestamp: Date.now() };
}

function networkFailure(status: number): BrowserSurfaceError {
  return {
    type: "network-failed",
    message: `HTTP ${status} GET /api/x`,
    statusCode: status,
    timestamp: Date.now(),
  };
}

describe("console / network buffer split", () => {
  beforeEach(async () => {
    // Let any flush timer queued by a previous test fire before we clear, so its
    // batch isn't counted against this one.
    await new Promise((r) => setTimeout(r, 150));
    sent.length = 0;
  });

  it("a chatty page does not evict recorded request failures", () => {
    const scope = makeScope();
    pushBrowserSurfaceError(scope, networkFailure(500));
    pushBrowserSurfaceError(scope, networkFailure(404));

    for (let i = 0; i < 600; i++) {
      pushBrowserSurfaceError(scope, consoleEntry("log", `chatter ${i}`));
    }

    const failures = getBrowserSurfaceNetworkFailures(scope);
    expect(failures).toHaveLength(2);
    expect(failures.map((f) => f.statusCode)).toEqual([500, 404]);
  });

  it("caps the console buffer without touching the network one", () => {
    const scope = makeScope();
    for (let i = 0; i < 700; i++) {
      pushBrowserSurfaceError(scope, consoleEntry("log", `n${i}`));
    }
    const entries = getBrowserConsoleEntries(scope);
    expect(entries.length).toBeLessThanOrEqual(500);
    // Eviction keeps the NEWEST — a console you scroll back through is useless
    // if it drops what just happened.
    expect(entries[entries.length - 1].message).toBe("n699");
  });

  it("routes by type: console levels and crashes to console, failures to network", () => {
    const scope = makeScope();
    pushBrowserSurfaceError(scope, consoleEntry("info", "hello"));
    pushBrowserSurfaceError(scope, {
      type: "load-failed",
      message: "nope",
      timestamp: Date.now(),
    });
    pushBrowserSurfaceError(scope, networkFailure(503));

    expect(getBrowserConsoleEntries(scope)).toHaveLength(2);
    expect(getBrowserSurfaceNetworkFailures(scope)).toHaveLength(1);
  });

  it("getBrowserSurfaceErrors still returns the union, so existing callers are unaffected", () => {
    const scope = makeScope();
    pushBrowserSurfaceError(scope, consoleEntry("error", "boom"));
    pushBrowserSurfaceError(scope, networkFailure(500));
    // The completion gate and browser_test both read this.
    expect(getBrowserSurfaceErrors(scope)).toHaveLength(2);
  });

  it("clear empties both buffers", () => {
    const scope = makeScope();
    pushBrowserSurfaceError(scope, consoleEntry("log", "a"));
    pushBrowserSurfaceError(scope, networkFailure(500));
    clearBrowserSurfaceErrors(scope);
    expect(getBrowserSurfaceErrors(scope)).toHaveLength(0);
  });
});

describe("IPC fan-out", () => {
  beforeEach(async () => {
    // Let any flush timer queued by a previous test fire before we clear, so its
    // batch isn't counted against this one.
    await new Promise((r) => setTimeout(r, 150));
    sent.length = 0;
  });

  it("browser:error stays error/warning-only — existing consumers see no change", () => {
    const scope = makeScope();
    pushBrowserSurfaceError(scope, consoleEntry("log", "chatter"));
    pushBrowserSurfaceError(scope, consoleEntry("debug", "chatter"));
    pushBrowserSurfaceError(scope, consoleEntry("info", "chatter"));

    expect(sent.filter((s) => s.channel === "browser:error")).toHaveLength(0);

    pushBrowserSurfaceError(scope, consoleEntry("warning", "hydration"));
    pushBrowserSurfaceError(scope, consoleEntry("error", "boom"));
    expect(sent.filter((s) => s.channel === "browser:error")).toHaveLength(2);
  });

  it("an error flushes the console batch immediately", () => {
    const scope = makeScope();
    pushBrowserSurfaceError(scope, consoleEntry("error", "boom"));
    const batches = sent.filter((s) => s.channel === "browser:console");
    expect(batches).toHaveLength(1);
    expect((batches[0].payload as BrowserSurfaceError[])[0].message).toBe("boom");
  });

  it("noisy levels are coalesced rather than sent per entry", async () => {
    const scope = makeScope();
    for (let i = 0; i < 50; i++) {
      pushBrowserSurfaceError(scope, consoleEntry("log", `n${i}`));
    }
    // Nothing sent yet — they are queued behind the flush timer.
    expect(sent.filter((s) => s.channel === "browser:console")).toHaveLength(0);

    await new Promise((r) => setTimeout(r, 200));

    const batches = sent.filter((s) => s.channel === "browser:console");
    expect(batches).toHaveLength(1);
    expect((batches[0].payload as BrowserSurfaceError[])).toHaveLength(50);
  });
});
