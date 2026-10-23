/**
 * The app's "Controlling your screen" pill: its Stop link and the stop
 * shortcut both end the turn through the same stop. QA cannot press the
 * shortcut (no OS key events) and saw the link do nothing on Electron 43 (A5).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

type Handler = (...args: unknown[]) => void;
const pages: Array<Record<string, Handler>> = [];
const shortcuts = new Map<string, Handler>();
const windowOptions: Array<Record<string, unknown>> = [];

vi.mock("electron", () => {
  class BrowserWindow {
    webContents: { on: (ev: string, h: Handler) => void };
    private handlers: Record<string, Handler> = {};
    private visible = false;
    constructor(opts: Record<string, unknown>) {
      windowOptions.push(opts);
      const handlers = this.handlers;
      pages.push(handlers);
      this.webContents = { on: (ev, h) => void (handlers[ev] = h) };
    }
    setContentProtection() {}
    setAlwaysOnTop() {}
    setVisibleOnAllWorkspaces() {}
    loadURL() {
      return Promise.resolve();
    }
    isDestroyed() {
      return false;
    }
    isVisible() {
      return this.visible;
    }
    showInactive() {
      this.visible = true;
    }
    hide() {
      this.visible = false;
    }
    setBounds() {}
  }
  return {
    BrowserWindow,
    globalShortcut: {
      isRegistered: (a: string) => shortcuts.has(a),
      register: (a: string, cb: Handler) => (shortcuts.set(a, cb), true),
      unregister: (a: string) => void shortcuts.delete(a),
    },
    screen: { getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1440, height: 900 } }) },
  };
});
vi.mock("electron-log", () => ({ default: { scope: () => ({ warn() {}, log() {} }) } }));

const { initComputerIndicator, STOP_ACCELERATOR } = await import("@/main/computer-indicator");
const { computerActivity } = await import("@/lib/tools/computer");
initComputerIndicator();

describe("the pill's stops", () => {
  // The pill hides 15 s after the last action: run that out between tests.
  beforeEach(() => {
    vi.useFakeTimers();
    computerActivity.emit("end");
    vi.advanceTimersByTime(16_000);
    vi.useRealTimers();
  });

  it("the Stop link is not a data: fragment, which Chromium blocks before any event (A5)", async () => {
    const loaded: string[] = [];
    const { BrowserWindow } = await import("electron");
    const orig = BrowserWindow.prototype.loadURL;
    BrowserWindow.prototype.loadURL = function (u: string) {
      loaded.push(u);
      return Promise.resolve();
    } as never;
    computerActivity.emit("start", { stop: vi.fn() });
    BrowserWindow.prototype.loadURL = orig;
    const page = decodeURIComponent(loaded.join(""));
    expect(page).toContain('href="https://atlarix.invalid/stop"');
    expect(page).not.toContain('href="#');
  });

  it("Stop on the pill ends the turn, through the navigation Electron reports", () => {
    const stop = vi.fn();
    computerActivity.emit("start", { stop });
    const page = pages[pages.length - 1]!;
    const prevented = vi.fn();
    page["will-navigate"]!({ preventDefault: prevented }, "https://atlarix.invalid/stop");
    expect(prevented).toHaveBeenCalled(); // never leaves the page, never fetched
    expect(stop).toHaveBeenCalledOnce();
    // A second event for the same click does not stop it twice.
    page["will-navigate"]!({ preventDefault: prevented }, "https://atlarix.invalid/stop");
    expect(stop).toHaveBeenCalledOnce();
  });

  it("takes the first click while unfocused, so the first pill's Stop is not lost (A5)", () => {
    computerActivity.emit("start", { stop: vi.fn() });
    expect(windowOptions.at(-1)).toMatchObject({ acceptFirstMouse: true });
  });

  it("other navigations are cancelled and stop nothing", () => {
    const stop = vi.fn();
    computerActivity.emit("start", { stop });
    const prevented = vi.fn();
    pages[pages.length - 1]!["will-navigate"]!({ preventDefault: prevented }, "https://example.com/");
    expect(prevented).toHaveBeenCalled();
    expect(stop).not.toHaveBeenCalled();
  });

  it("the shortcut, registered only while the pill shows, calls the same stop", () => {
    const stop = vi.fn();
    expect(shortcuts.has(STOP_ACCELERATOR)).toBe(false);
    computerActivity.emit("start", { stop });
    expect(shortcuts.has(STOP_ACCELERATOR)).toBe(true);
    shortcuts.get(STOP_ACCELERATOR)!();
    expect(stop).toHaveBeenCalledOnce();
    // Stopped: the shortcut is given back to the system.
    expect(shortcuts.has(STOP_ACCELERATOR)).toBe(false);
  });
});
