/**
 * The browser is per WINDOW.
 *
 * THE BUG: `browser_view_manager` kept `tabs`, `activeTabId`, `visible`,
 * `lastBounds`, `attachedWindow` and the page-error buffer at MODULE level, and
 * `hostWindow()` fell back to `getAllWindows().find(...)` — the first window. So
 * every window shared one tab set and one panel: window 1's browsing genuinely
 * appeared in window 2, and the view could attach to a window that never asked
 * for it. `lastBounds` was the quiet one — two windows of different sizes shared
 * a single geometry, so the view laid out at the wrong width in one of them.
 *
 * These tests use fake windows: the point is the SCOPE bookkeeping, and the
 * WebContentsView side needs a real Electron runtime (covered by the two-window
 * packaged pass, which is the actual gate for this change).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

/** Minimal BrowserWindow stand-ins, keyed by id like the real thing. */
const windows = new Map<number, FakeWindow>();
class FakeWindow {
  destroyed = false;
  contentView = {
    children: [],
    addChildView: vi.fn(),
    removeChildView: vi.fn(),
  };
  webContents = {
    isDestroyed: () => false,
    isCrashed: () => false,
    send: vi.fn(),
  };
  private closedHandlers: Array<() => void> = [];
  constructor(public id: number) {
    windows.set(id, this);
  }
  isDestroyed() {
    return this.destroyed;
  }
  getContentBounds() {
    return { x: 0, y: 0, width: 1600, height: 900 };
  }
  once(evt: string, fn: () => void) {
    if (evt === "closed") this.closedHandlers.push(fn);
  }
  close() {
    this.destroyed = true;
    for (const fn of this.closedHandlers) fn();
  }
}

let focusedId: number | null = null;

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
    fromId: (id: number) => windows.get(id) ?? null,
    getFocusedWindow: () =>
      focusedId != null ? (windows.get(focusedId) ?? null) : null,
    getAllWindows: () => [...windows.values()].filter((w) => !w.destroyed),
  },
}));

import {
  browserScopeForWindow,
  resolveBrowserScope,
  getBrowserPanelState,
  getActiveTabId,
  getTabCount,
} from "@/ipc/utils/browser_view_manager";

function makeWindow(id: number) {
  return new FakeWindow(id) as unknown as Parameters<
    typeof browserScopeForWindow
  >[0];
}

describe("per-window browser scopes", () => {
  beforeEach(() => {
    windows.clear();
    focusedId = null;
  });

  it("REGRESSION: two windows do not share tab state", () => {
    const one = browserScopeForWindow(makeWindow(1));
    const two = browserScopeForWindow(makeWindow(2));

    expect(one).not.toBe(two);
    expect(one.tabs).not.toBe(two.tabs);

    // Simulate window 1 opening a tab and going visible.
    one.tabs.set(101, {} as never);
    one.activeTabId = 101;
    one.visible = true;

    expect(getTabCount(one)).toBe(1);
    expect(getTabCount(two)).toBe(0);
    expect(getActiveTabId(two)).toBeNull();
    expect(getBrowserPanelState(two).visible).toBe(false);
  });

  it("REGRESSION: panel geometry is per window", () => {
    // Two differently-sized windows previously shared one `lastBounds`, so the
    // view laid out at the wrong width in whichever had not reported last.
    const one = browserScopeForWindow(makeWindow(1));
    const two = browserScopeForWindow(makeWindow(2));
    one.lastBounds = { x: 0, y: 0, width: 800, height: 600 };
    two.lastBounds = { x: 0, y: 0, width: 400, height: 300 };
    expect(one.lastBounds.width).toBe(800);
    expect(two.lastBounds.width).toBe(400);
  });

  it("REGRESSION: page errors belong to the window that produced them", () => {
    const one = browserScopeForWindow(makeWindow(1));
    const two = browserScopeForWindow(makeWindow(2));
    one.consoleEntries.push({
      type: "console-error",
      message: "boom in window 1",
      timestamp: 1,
    } as never);
    expect(two.consoleEntries).toHaveLength(0);
  });

  it("returns the same scope for the same window", () => {
    const win = makeWindow(1);
    expect(browserScopeForWindow(win)).toBe(browserScopeForWindow(win));
  });

  it("resolves by explicit window id — the id the tool funnel injects", () => {
    const one = browserScopeForWindow(makeWindow(1));
    browserScopeForWindow(makeWindow(2));
    focusedId = 2; // focus is elsewhere; the explicit id must still win
    expect(resolveBrowserScope(1)).toBe(one);
  });

  it("falls back to the focused window when no id is given", () => {
    browserScopeForWindow(makeWindow(1));
    const two = browserScopeForWindow(makeWindow(2));
    focusedId = 2;
    // Automations and headless runs have no window id to pass; this is the
    // previous single-window behaviour rather than a failure.
    expect(resolveBrowserScope()).toBe(two);
  });

  it("falls back to the only window when nothing is focused", () => {
    const one = browserScopeForWindow(makeWindow(1));
    focusedId = null;
    expect(resolveBrowserScope()).toBe(one);
  });

  it("ignores a stale window id rather than throwing", () => {
    const one = browserScopeForWindow(makeWindow(1));
    focusedId = 1;
    expect(resolveBrowserScope(999)).toBe(one);
  });

  it("returns null when there is no window at all", () => {
    expect(resolveBrowserScope()).toBeNull();
  });

  it("drops a window's scope when it closes", () => {
    const win = makeWindow(1);
    browserScopeForWindow(win);
    (win as unknown as FakeWindow).close();
    // A fresh window reusing the id must not inherit the old tabs.
    windows.clear();
    const reused = browserScopeForWindow(makeWindow(1));
    expect(reused.tabs.size).toBe(0);
  });
});
