/**
 * The agent's browser lives in a HIDDEN host window (the visible Browser panel
 * was retired on 2026-09-23).
 *
 * What must hold, each a failure that would otherwise be silent:
 *  - The active tab is attached to the host, SIZED and DRAWN. An unattached view
 *    lays out at zero width (every geometry answer plausible and wrong); an
 *    undrawn one screenshots as its last retained frame.
 *  - The host is never a user window: hidden, unfocusable, off the taskbar, and
 *    skipped when a scope is resolved by enumeration.
 *  - The host dies with the window it belongs to. A live hidden window keeps
 *    `window-all-closed` from firing, so Windows/Linux would never quit.
 *
 * Fake windows on purpose: the subject is attachment bookkeeping; real
 * Chromium painting is covered by the packaged pass.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const windows = new Map<number, FakeWindow>();
let nextId = 100;

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
    getURL: () => "http://localhost:5173/",
    getTitle: () => "dev server",
    isLoading: () => false,
    navigationHistory: { canGoBack: () => false, canGoForward: () => false },
  };
}

class FakeWindow {
  destroyed = false;
  attached: FakeView[] = [];
  options: Record<string, unknown>;
  private closedHandlers: Array<() => void> = [];
  contentView = {
    children: [] as FakeView[],
    addChildView: (v: FakeView) => {
      if (!this.attached.includes(v)) this.attached.push(v);
      this.contentView.children = this.attached;
    },
    removeChildView: (v: FakeView) => {
      this.attached = this.attached.filter((x) => x !== v);
      this.contentView.children = this.attached;
    },
  };
  webContents = { isDestroyed: () => false, isCrashed: () => false, send: vi.fn() };
  constructor(
    public id: number,
    options: Record<string, unknown> = {},
  ) {
    this.options = options;
    windows.set(id, this);
  }
  isDestroyed() {
    return this.destroyed;
  }
  destroy() {
    this.destroyed = true;
  }
  once(evt: string, cb: () => void) {
    if (evt === "closed") this.closedHandlers.push(cb);
  }
  close() {
    this.destroyed = true;
    for (const cb of this.closedHandlers) cb();
  }
}

vi.mock("electron", () => ({
  WebContentsView: class {},
  session: {
    fromPartition: () => ({
      setPermissionRequestHandler() {},
      on() {},
      webRequest: { onCompleted() {} },
    }),
  },
  // Constructible, because the manager creates its host with `new BrowserWindow`.
  // FakeWindow is referenced only when called, after it has been declared.
  BrowserWindow: class {
    constructor(options: Record<string, unknown>) {
      return new FakeWindow(nextId++, options);
    }
    static fromId(id: number) {
      return windows.get(id) ?? null;
    }
    static getFocusedWindow() {
      return null;
    }
    static getAllWindows() {
      return [...windows.values()].filter((w) => !w.destroyed);
    }
  },
}));

import {
  BROWSER_VIEWPORT,
  browserScopeForWindow,
  getActiveTabId,
  isBrowserHostWindow,
  resolveBrowserScope,
  setActiveTab,
} from "@/ipc/utils/browser_view_manager";

function makeScope(id = 1) {
  const win = new FakeWindow(id);
  const scope = browserScopeForWindow(
    win as unknown as Parameters<typeof browserScopeForWindow>[0],
  );
  return { win, scope };
}

function addTab(scope: ReturnType<typeof makeScope>["scope"], id: number) {
  const view = new FakeView();
  scope.tabs.set(id, view as never);
  return view;
}

const hostOf = (scope: ReturnType<typeof makeScope>["scope"]) =>
  scope.host as unknown as FakeWindow;

describe("the agent browser's hidden host", () => {
  beforeEach(() => {
    windows.clear();
  });

  it("attaches the active tab to the HOST, never the user's window", () => {
    const { win, scope } = makeScope(1);
    const view = addTab(scope, 7);

    setActiveTab(scope, 7);

    expect(hostOf(scope).attached).toContain(view);
    expect(win.attached).not.toContain(view);
    expect(getActiveTabId(scope)).toBe(7);
  });

  it("sizes the view to the fixed viewport and DRAWS it", () => {
    const { scope } = makeScope(1);
    const view = addTab(scope, 7);

    setActiveTab(scope, 7);

    expect(view.bounds).toEqual({ x: 0, y: 0, ...BROWSER_VIEWPORT });
    // Drawn: an undrawn view screenshots as a stale retained frame.
    expect(view.visible).toBe(true);
  });

  it("creates the host hidden, unfocusable, off the taskbar, unthrottled — and marked", () => {
    const { scope } = makeScope(1);
    addTab(scope, 7);
    setActiveTab(scope, 7);

    const host = hostOf(scope);
    expect(host.options).toMatchObject({
      show: false,
      focusable: false,
      skipTaskbar: true,
      width: BROWSER_VIEWPORT.width,
      height: BROWSER_VIEWPORT.height,
      webPreferences: { backgroundThrottling: false },
    });
    // NOT offscreen rendering — a different paint and capture model.
    expect(JSON.stringify(host.options)).not.toContain("offscreen");
    expect(isBrowserHostWindow(host as never)).toBe(true);
  });

  it("only the active tab is attached", () => {
    const { scope } = makeScope(1);
    const first = addTab(scope, 1);
    const second = addTab(scope, 2);

    setActiveTab(scope, 1);
    setActiveTab(scope, 2);

    expect(hostOf(scope).attached).toContain(second);
    expect(hostOf(scope).attached).not.toContain(first);
  });

  it("destroys the host when its window closes, so the app can still quit", () => {
    const { win, scope } = makeScope(1);
    addTab(scope, 7);
    setActiveTab(scope, 7);
    const host = hostOf(scope);

    win.close();

    expect(host.destroyed).toBe(true);
  });

  it("never resolves a scope for a host window", () => {
    // The fallback enumerates windows; if the host were picked it would get a
    // browser scope — and a host — of its own.
    const { win, scope } = makeScope(1);
    addTab(scope, 7);
    setActiveTab(scope, 7);
    // Make the host the FIRST window the fallback would see.
    windows.delete(win.id);
    windows.set(win.id, win);

    const resolved = resolveBrowserScope();
    expect(resolved?.window).toBe(win);
  });
});
