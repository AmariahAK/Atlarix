/**
 * The agent's browser tools must work with the right panel CLOSED.
 *
 * THE BUG, as reported: driving `browser_navigate` at a local dev server did
 * nothing useful until the user opened the right panel by hand.
 *
 * THE MECHANISM. `setActiveTab` and `setVisible` only called
 * `contentView.addChildView(view)` when `scope.visible` was true, so with the
 * panel shut the `WebContentsView` was created and navigated but never attached
 * to a window. An unattached view has no layout viewport: the document lays out
 * at zero width and every geometry answer is plausible and wrong. The guard
 * against exactly this — `fallbackBounds`, whose docblock describes the 0x0
 * layout viewport — was only ever applied on the attach path, so it could not
 * run on the one path it was written for.
 *
 * THE FIX. Always attach and always size; `View.setVisible` decides whether the
 * compositor DRAWS it. That keeps the reason the old conditional existed (a
 * drawn view with no React chrome around it is a bare browser slab over half the
 * app) while removing the consequence nobody wanted.
 *
 * These use fake windows deliberately: the assertion is about attachment
 * bookkeeping, and the real Chromium behaviour is covered by the packaged pass.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const windows = new Map<number, FakeWindow>();

/** Records attach/detach and per-view visibility, which is the whole subject. */
class FakeView {
  visible: boolean | null = null;
  bounds: { x: number; y: number; width: number; height: number } | null = null;
  setVisible(v: boolean) {
    this.visible = v;
  }
  setBounds(b: { x: number; y: number; width: number; height: number }) {
    this.bounds = b;
  }
  webContents = {
    isDestroyed: () => false,
    close: vi.fn(),
    loadURL: vi.fn(() => Promise.resolve()),
    on: vi.fn(),
    setWindowOpenHandler: vi.fn(),
    // Read by `getBrowserPanelState`, which `broadcastState` calls on every
    // activation — so these are load-bearing even though nothing asserts them.
    getURL: () => "http://localhost:5173/",
    getTitle: () => "dev server",
    isLoading: () => false,
    navigationHistory: { canGoBack: () => false, canGoForward: () => false },
  };
}

class FakeWindow {
  destroyed = false;
  attached: FakeView[] = [];
  contentView = {
    children: [] as FakeView[],
    addChildView: (v: FakeView) => {
      if (!this.attached.includes(v)) this.attached.push(v);
    },
    removeChildView: (v: FakeView) => {
      this.attached = this.attached.filter((x) => x !== v);
    },
  };
  webContents = {
    isDestroyed: () => false,
    isCrashed: () => false,
    send: vi.fn(),
  };
  constructor(public id: number) {
    windows.set(id, this);
  }
  isDestroyed() {
    return this.destroyed;
  }
  getContentBounds() {
    return { x: 0, y: 0, width: 1600, height: 900 };
  }
  once() {}
}

vi.mock("electron", () => ({
  // A bare stand-in: these tests register tabs directly rather than going
  // through `createTab`, so the constructor is never called. (The factory is
  // hoisted above the class declarations, so it cannot reference FakeView.)
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
    getFocusedWindow: () => null,
    getAllWindows: () => [...windows.values()].filter((w) => !w.destroyed),
  },
}));

import {
  browserScopeForWindow,
  setActiveTab,
  setVisible,
  getActiveTabId,
} from "@/ipc/utils/browser_view_manager";

function makeScope(id = 1) {
  const win = new FakeWindow(id);
  const scope = browserScopeForWindow(
    win as unknown as Parameters<typeof browserScopeForWindow>[0],
  );
  return { win, scope };
}

/** A tab registered directly, so the test does not depend on createTab's I/O. */
function addTab(scope: ReturnType<typeof makeScope>["scope"], id: number) {
  const view = new FakeView();
  scope.tabs.set(id, view as never);
  return view;
}

describe("a browser tab is attached whether or not the panel is open", () => {
  beforeEach(() => {
    windows.clear();
  });

  it("REGRESSION: activating a tab with the panel CLOSED still attaches it", () => {
    const { win, scope } = makeScope(1);
    const view = addTab(scope, 7);
    expect(scope.visible).toBe(false);

    setActiveTab(scope, 7);

    // This is the assertion the bug was: it used to be 0.
    expect(win.attached).toContain(view);
    expect(getActiveTabId(scope)).toBe(7);
  });

  it("REGRESSION: a closed panel still gives the view real bounds, never 0x0", () => {
    // A view whose rect does not intersect the window lays out at zero width,
    // and every geometry answer an agent gets back is then wrong but plausible.
    const { scope } = makeScope(1);
    const view = addTab(scope, 7);

    setActiveTab(scope, 7);

    expect(view.bounds).not.toBeNull();
    expect(view.bounds!.width).toBeGreaterThan(0);
    expect(view.bounds!.height).toBeGreaterThan(0);
  });

  it("does not DRAW the view while the panel is closed", () => {
    // The reason the old conditional existed: a drawn view with no React chrome
    // around it is a bare browser slab over half the app. Attached-but-hidden
    // keeps that fixed while the tools keep working.
    const { scope } = makeScope(1);
    const view = addTab(scope, 7);

    setActiveTab(scope, 7);
    expect(view.visible).toBe(false);
  });

  it("draws it as soon as the panel opens, without re-navigating", () => {
    const { win, scope } = makeScope(1);
    const view = addTab(scope, 7);
    setActiveTab(scope, 7);

    setVisible(scope, true);

    expect(view.visible).toBe(true);
    expect(win.attached).toContain(view);
    // The page was never reloaded to become visible — whatever the agent had
    // already loaded is what the user now sees.
    expect(view.webContents.loadURL).not.toHaveBeenCalled();
  });

  it("hiding the panel stops drawing but keeps the view attached", () => {
    const { win, scope } = makeScope(1);
    const view = addTab(scope, 7);
    setActiveTab(scope, 7);
    setVisible(scope, true);

    setVisible(scope, false);

    expect(view.visible).toBe(false);
    // The old code removed it here, which is precisely what left the agent
    // driving a view with no layout viewport.
    expect(win.attached).toContain(view);
  });

  it("only the active tab is attached", () => {
    const { win, scope } = makeScope(1);
    const first = addTab(scope, 1);
    const second = addTab(scope, 2);

    setActiveTab(scope, 1);
    setActiveTab(scope, 2);

    expect(win.attached).toContain(second);
    expect(win.attached).not.toContain(first);
  });
});
