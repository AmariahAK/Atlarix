/**
 * The worker must survive a browser that has no side panel.
 *
 * ══ THE BUG THIS PINS ══
 *
 * `api().sidePanel.setPanelBehavior({…}).catch(log)` was the worker's FIRST
 * statement. In a Chromium fork without `chrome.sidePanel` — Arc — `sidePanel`
 * is undefined, reading `.setPanelBehavior` throws a SYNCHRONOUS TypeError, and
 * a `.catch()` chained onto a call that never happened cannot see it. Module
 * evaluation aborted on line one, so `connectBridge()` further down never ran.
 * The extension was not panel-less; it was inert. "It downloaded, but it didn't
 * turn on."
 *
 * So the assertion that matters is NOT "the fallback opens a window" — it is
 * that `connectBridge` is still called. A test that only checked the panel
 * behaviour would pass against the bug, because the panel was never the part
 * that broke.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const connectBridge = vi.fn();
const installBridgeAlarm = vi.fn();
const setPanelBehavior = vi.fn();
const windowsCreate = vi.fn();
const onClickedAddListener = vi.fn();

/** A namespace with the pieces every build has, and `sidePanel` optional. */
function namespaceWith(opts: { sidePanel: boolean }) {
  return {
    runtime: { getURL: (p: string) => `chrome-extension://x/${p}` },
    windows: { create: windowsCreate },
    action: { onClicked: { addListener: onClickedAddListener } },
    ...(opts.sidePanel ? { sidePanel: { setPanelBehavior } } : {}),
  };
}

const apiMock = vi.fn();
vi.mock("../shared/browser-api", () => ({ api: () => apiMock() }));
vi.mock("../bridge/native-port", () => ({
  connectBridge: () => connectBridge(),
  installBridgeAlarm: () => installBridgeAlarm(),
}));

async function loadWorker(opts: { sidePanel: boolean }) {
  vi.resetModules();
  apiMock.mockReturnValue(namespaceWith(opts));
  await import("./service-worker");
}

beforeEach(() => {
  connectBridge.mockReset();
  installBridgeAlarm.mockReset();
  setPanelBehavior.mockReset().mockResolvedValue(undefined);
  windowsCreate.mockReset().mockResolvedValue({ id: 1 });
  onClickedAddListener.mockReset();
  apiMock.mockReset();
});

describe("a browser WITHOUT chrome.sidePanel (Arc)", () => {
  it("still connects the desktop bridge", async () => {
    await loadWorker({ sidePanel: false });
    expect(connectBridge).toHaveBeenCalled();
    expect(installBridgeAlarm).toHaveBeenCalled();
  });

  it("falls back to opening the panel in a window", async () => {
    await loadWorker({ sidePanel: false });
    expect(onClickedAddListener).toHaveBeenCalled();

    // Fire the registered click handler.
    const handler = onClickedAddListener.mock.calls[0][0] as () => void;
    handler();
    await Promise.resolve();
    expect(windowsCreate).toHaveBeenCalledWith(
      expect.objectContaining({ type: "popup" }),
    );
  });

  it("does not attempt setPanelBehavior", async () => {
    await loadWorker({ sidePanel: false });
    expect(setPanelBehavior).not.toHaveBeenCalled();
  });
});

describe("a browser WITH chrome.sidePanel", () => {
  it("registers the panel behaviour and connects the bridge", async () => {
    await loadWorker({ sidePanel: true });
    expect(setPanelBehavior).toHaveBeenCalledWith({
      openPanelOnActionClick: true,
    });
    expect(connectBridge).toHaveBeenCalled();
    // No fallback listener when the real thing is available, or the toolbar
    // click would both open the panel AND spawn a window.
    expect(onClickedAddListener).not.toHaveBeenCalled();
  });

  it("survives setPanelBehavior REJECTING, and still has the bridge up", async () => {
    setPanelBehavior.mockRejectedValue(new Error("nope"));
    await loadWorker({ sidePanel: true });
    expect(connectBridge).toHaveBeenCalled();
  });
});
