/**
 * The bridged ops, at the level where they were actually wrong: the ARGUMENTS.
 *
 * WHY THIS TEST EXISTS. `scroll` shipped passing `{ref, to, by}` to a kernel op
 * whose signature is `{direction, amount}`, with an `as never` cast silencing
 * the mismatch. Nothing failed: `req.direction` was simply `undefined`, the
 * kernel fell through to its `else`, and every bridged scroll went DOWN one
 * viewport — never up, never to top or bottom, and `by` ignored. A silent wrong
 * answer is the worst kind, and a test that only checked "the op returned
 * something" would have passed against it for as long as it existed.
 *
 * So these assert the exact payload handed to the page, not the reply.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const runInPage = vi.fn();
const tabsGet = vi.fn();
const tabsQuery = vi.fn();
const tabsUpdate = vi.fn();
const tabsCreate = vi.fn();
const isAgentTabMock = vi.fn();
const setGroupTitleMock = vi.fn();
const attachMock = vi.fn();
const pressKeyMock = vi.fn();
const movePointerMock = vi.fn();
const beginCaptureMock = vi.fn();
const armNetworkMock = vi.fn();
const endCaptureMock = vi.fn();
const readConsoleMock = vi.fn();
const readNetworkMock = vi.fn();
const captureScreenshotMock = vi.fn();
const captureVisibleTabMock = vi.fn();
const runPageFunctionMock = vi.fn();
const injectPackagedFileMock = vi.fn();
const readNetworkBodyMock = vi.fn();
/** Every call in order, to pin capture-BEFORE-navigation. */
const order: string[] = [];
/** The onUpdated listener serve.ts registered, so a test can fire "complete". */
let updatedListener:
  | ((id: number, info: { status?: string }) => void)
  | null = null;

vi.mock("../page/inject", () => ({
  runInPage: (...a: unknown[]) => runInPage(...a),
  runPageFunction: (...a: unknown[]) => runPageFunctionMock(...a),
  injectPackagedFile: (...a: unknown[]) => injectPackagedFileMock(...a),
  activeTab: async () => ({ id: 7, url: "https://example.com/" }),
}));
vi.mock("../tabs/group", () => ({
  adoptTab: vi.fn(async () => {}),
  isAgentTab: (...a: unknown[]) => isAgentTabMock(...a),
  setGroupTitle: (...a: unknown[]) => setGroupTitleMock(...a),
}));
vi.mock("../page/cdp-capture", () => ({
  beginCapture: (...a: unknown[]) => beginCaptureMock(...a),
  armNetwork: (...a: unknown[]) => armNetworkMock(...a),
  endCapture: (...a: unknown[]) => endCaptureMock(...a),
  readConsole: (...a: unknown[]) => readConsoleMock(...a),
  readNetwork: (...a: unknown[]) => readNetworkMock(...a),
  readNetworkBody: (...a: unknown[]) => readNetworkBodyMock(...a),
}));
vi.mock("../page/trusted-input", () => ({
  attach: (...a: unknown[]) => attachMock(...a),
  pressKey: (...a: unknown[]) => pressKeyMock(...a),
  movePointer: (...a: unknown[]) => movePointerMock(...a),
  captureScreenshot: (...a: unknown[]) => captureScreenshotMock(...a),
  isNamedKey: (n: string) => ["Enter", "Escape", "Tab"].includes(n),
  namedKeys: () => ["Enter", "Escape", "Tab"],
}));
vi.mock("../shared/browser-api", () => ({
  api: () => ({
    tabs: {
      get: (...a: unknown[]) => tabsGet(...a),
      query: (...a: unknown[]) => tabsQuery(...a),
      create: (...a: unknown[]) => tabsCreate(...a),
      update: (...a: unknown[]) => tabsUpdate(...a),
      onUpdated: {
        addListener: (cb: typeof updatedListener) => {
          updatedListener = cb;
        },
        removeListener: () => {
          updatedListener = null;
        },
      },
      captureVisibleTab: (...a: unknown[]) => captureVisibleTabMock(...a),
      remove: async () => {},
    },
  }),
}));

import { serveBridgeRequest } from "./serve";

const call = (op: string, args: Record<string, unknown> = {}) =>
  serveBridgeRequest({ id: "d1", op, args });

beforeEach(() => {
  runInPage.mockReset();
  tabsGet.mockReset().mockResolvedValue({ id: 7, url: "https://example.com/", windowId: 1 });
  tabsQuery.mockReset().mockResolvedValue([]);
  order.length = 0;
  updatedListener = null;
  // A navigation "completes" as soon as it is issued, like a fast page.
  tabsUpdate.mockReset().mockImplementation(async (id: number) => {
    order.push(`update:${id}`);
    queueMicrotask(() => updatedListener?.(id, { status: "complete" }));
  });
  tabsCreate.mockReset().mockResolvedValue({ id: 9, windowId: 1 });
  // Default for the arg-mapping suites: tab 7 is the agent's own.
  isAgentTabMock.mockReset().mockResolvedValue(true);
  setGroupTitleMock.mockReset().mockResolvedValue(undefined);
  attachMock.mockReset().mockResolvedValue(undefined);
  pressKeyMock.mockReset().mockResolvedValue(undefined);
  movePointerMock.mockReset().mockResolvedValue(undefined);
  beginCaptureMock.mockReset().mockImplementation(async (id: number) => {
    order.push(`capture:${id}`);
  });
  runPageFunctionMock.mockReset();
  injectPackagedFileMock.mockReset().mockResolvedValue(true);
  readNetworkBodyMock.mockReset();
  armNetworkMock.mockReset().mockResolvedValue(undefined);
  endCaptureMock.mockReset().mockResolvedValue(undefined);
  readConsoleMock.mockReset().mockReturnValue({ entries: [] });
  readNetworkMock.mockReset().mockReturnValue({ entries: [] });
  captureScreenshotMock
    .mockReset()
    .mockResolvedValue({ data: "AAAA", width: 1280, height: 720 });
  captureVisibleTabMock.mockReset().mockResolvedValue("data:image/png;base64,BBBB");
});

/** Page-op calls with the overlay assertion filtered out. */
const pageOpCalls = () =>
  runInPage.mock.calls.filter((c) => (c[1] as { op?: string })?.op !== "overlay");

describe("scroll sends what the kernel actually reads", () => {
  it.each(["up", "down", "top", "bottom"])(
    "passes direction:%s through, not `to`",
    async (direction) => {
      runInPage.mockResolvedValue({ ok: true });
      await call("scroll", { direction, amount: 250 });
      expect(runInPage).toHaveBeenCalledWith(7, {
        op: "scroll",
        direction,
        amount: 250,
      });
      const sent = pageOpCalls()[0][1] as Record<string, unknown>;
      expect(sent).not.toHaveProperty("to");
      expect(sent).not.toHaveProperty("by");
    },
  );

  it("routes a ref to `resolve`, which scrolls it into view", async () => {
    runInPage.mockResolvedValue({ ok: true });
    await call("scroll", { ref: "e4" });
    expect(runInPage).toHaveBeenCalledWith(7, { op: "resolve", ref: "e4" });
  });

  it("refuses horizontal scrolling by name instead of scrolling down", async () => {
    const reply = await call("scroll", { direction: "left" });
    expect(reply.ok).toBe(false);
    if (reply.ok) return;
    expect(reply.error).toContain("left");
    // There is no other browser to send the model to any more.
    expect(reply.error).not.toContain('target:"app"');
    expect(runInPage).not.toHaveBeenCalled();
  });

  it("rejects a missing direction rather than defaulting to down", async () => {
    const reply = await call("scroll", {});
    expect(reply.ok).toBe(false);
    if (reply.ok) return;
    expect(reply.error).toContain("direction");
  });
});

describe("the text op", () => {
  it("passes the selector and the shared budget", async () => {
    runInPage.mockResolvedValue({ ok: true, text: "hello", clipped: false });
    const reply = await call("text", { selector: "main" });
    expect(reply.ok).toBe(true);
    const sent = pageOpCalls()[0][1] as Record<string, unknown>;
    expect(sent.op).toBe("text");
    expect(sent.selector).toBe("main");
    expect(sent.max).toBe(60_000);
  });

  it("surfaces the kernel's own error rather than an empty string", async () => {
    runInPage.mockResolvedValue({ ok: false, error: 'No element matched selector "#x".' });
    const reply = await call("text", { selector: "#x" });
    expect(reply.ok).toBe(false);
    if (reply.ok) return;
    expect(reply.error).toContain("#x");
  });

  it("runs with NO permission check of its own", async () => {
    // THE INVERSION IS THE FEATURE. This used to assert a refusal. Host access
    // is a required manifest permission now, so a desktop-driven request just
    // runs; if a user narrows Site access in chrome://extensions, Chrome
    // refuses the injection and its own error surfaces. Three rounds of live
    // testing died on the gate this replaced.
    runInPage.mockResolvedValue({ ok: true, text: "hi", clipped: false });
    const reply = await call("text", {});
    expect(reply.ok).toBe(true);
    expect(runInPage).toHaveBeenCalled();
  });
});

describe("an op this build does not have", () => {
  it("says the build may be older than the app asking", async () => {
    const reply = await call("teleport", {});
    expect(reply.ok).toBe(false);
    if (reply.ok) return;
    expect(reply.error).toContain("older than the desktop app");
  });
});

/**
 * THE AGENT WORKS BESIDE THE USER, NOT ON TOP OF THEM.
 *
 * `targetTab` used to fall straight through to the ACTIVE tab, so "read the
 * page" meant whatever the user had switched to a moment ago — a wrong answer
 * sourced from their private browsing, and a click that could land in their
 * mail. These pin the preference and, just as importantly, the escape hatch:
 * the user's tab is still reachable, but only when asked for by id.
 */
describe("the agent prefers its own tab group", () => {
  it("reads its own tab, not the tab the user is looking at", async () => {
    tabsQuery.mockResolvedValue([
      { id: 3, lastAccessed: 500, active: true },
      { id: 42, lastAccessed: 100, active: false },
    ]);
    // Only 42 is the agent's; 3 is the user's active tab.
    isAgentTabMock.mockImplementation(async (id: number) => id === 42);
    tabsGet.mockResolvedValue({ id: 42, url: "https://agent.example/", windowId: 1 });
    runInPage.mockResolvedValue({ ok: true, text: "x", clipped: false });

    await call("text", {});
    expect(pageOpCalls()[0][0]).toBe(42);
  });

  it("picks the most recently touched of its own tabs", async () => {
    tabsQuery.mockResolvedValue([
      { id: 11, lastAccessed: 100 },
      { id: 12, lastAccessed: 900 },
    ]);
    isAgentTabMock.mockResolvedValue(true);
    tabsGet.mockResolvedValue({ id: 12, url: "https://agent.example/", windowId: 1 });
    runInPage.mockResolvedValue({ ok: true, text: "x", clipped: false });

    await call("text", {});
    expect(pageOpCalls()[0][0]).toBe(12);
  });

  it("falls back to the active tab only when it owns none", async () => {
    tabsQuery.mockResolvedValue([{ id: 3, active: true }]);
    isAgentTabMock.mockResolvedValue(false);
    tabsGet.mockResolvedValue({ id: 7, url: "https://example.com/", windowId: 1 });
    runInPage.mockResolvedValue({ ok: true, text: "x", clipped: false });

    await call("text", {});
    // `activeTab()` is mocked to tab 7.
    expect(pageOpCalls()[0][0]).toBe(7);
  });

  it("still lets the caller name the user's tab explicitly", async () => {
    isAgentTabMock.mockResolvedValue(false);
    tabsGet.mockResolvedValue({ id: 3, url: "https://mail.example/", windowId: 1 });
    runInPage.mockResolvedValue({ ok: true, text: "x", clipped: false });

    await call("text", { tab_id: 3 });
    expect(pageOpCalls()[0][0]).toBe(3);
    // No tab enumeration at all when an id was given.
    expect(tabsQuery).not.toHaveBeenCalled();
  });
});

describe("navigate stays inside the agent's group", () => {
  it("reuses the agent's existing tab instead of breeding new ones", async () => {
    tabsQuery.mockResolvedValue([{ id: 42 }]);
    isAgentTabMock.mockImplementation(async (id: number) => id === 42);

    const reply = await call("navigate", { url: "https://b.example/" });
    expect(reply.ok).toBe(true);
    expect(tabsUpdate).toHaveBeenCalledWith(42, { url: "https://b.example/" });
    expect(tabsCreate).not.toHaveBeenCalled();
  });

  it("creates one in the background, unfocused, when it owns none", async () => {
    tabsQuery.mockResolvedValue([{ id: 3 }]);
    isAgentTabMock.mockResolvedValue(false);

    const reply = await call("navigate", { url: "https://b.example/" });
    expect(reply.ok).toBe(true);
    // Opened BLANK, so capture can attach before the real page loads...
    expect(tabsCreate).toHaveBeenCalledWith({
      url: "about:blank",
      active: false,
    });
    // ...then pointed at the page.
    expect(tabsUpdate).toHaveBeenCalledWith(9, { url: "https://b.example/" });
  });

  it("starts capture BEFORE the page loads, so its first logs are not missed", async () => {
    tabsQuery.mockResolvedValue([]);
    await call("navigate", { url: "https://b.example/" });
    expect(order).toEqual(["capture:9", "update:9"]);
  });

  it("waits for the load and reports it", async () => {
    tabsQuery.mockResolvedValue([{ id: 42 }]);
    isAgentTabMock.mockImplementation(async (id: number) => id === 42);
    const reply = await call("navigate", { url: "https://b.example/" });
    expect(reply.ok).toBe(true);
    if (!reply.ok) return;
    expect(reply.result).toMatchObject({ tabId: 42, loaded: true, reused: true });
    expect(typeof (reply.result as { navigatedAt?: unknown }).navigatedAt).toBe(
      "number",
    );
  });

  it("open_tab uses the same capture-first order in a new tab", async () => {
    const reply = await call("open_tab", { url: "https://c.example/" });
    expect(reply.ok).toBe(true);
    expect(tabsCreate).toHaveBeenCalledWith({ url: "about:blank", active: false });
    expect(order).toEqual(["capture:9", "update:9"]);
  });

  it("open_tab with no url opens a blank tab in the group and loads nothing", async () => {
    const reply = await call("open_tab", {});
    expect(reply.ok).toBe(true);
    if (!reply.ok) return;
    expect(tabsCreate).toHaveBeenCalledWith({ url: "about:blank", active: false });
    expect(tabsUpdate).not.toHaveBeenCalled();
    expect(reply.result).toMatchObject({ tabId: 9, url: "about:blank", blank: true });
  });

  it("refuses to navigate a tab the user owns", async () => {
    isAgentTabMock.mockResolvedValue(false);
    const reply = await call("navigate", {
      url: "https://b.example/",
      tab_id: 3,
    });
    expect(reply.ok).toBe(false);
    if (reply.ok) return;
    expect(reply.error).toContain("not one Atlarix opened");
    expect(tabsUpdate).not.toHaveBeenCalled();
  });

  it("rejects a non-http URL", async () => {
    const reply = await call("navigate", { url: "javascript:alert(1)" });
    expect(reply.ok).toBe(false);
    if (reply.ok) return;
    expect(reply.error).toContain("http(s)");
  });
});

describe("close_tab still refuses the user's tabs", () => {
  it("will not close a tab the agent did not open", async () => {
    isAgentTabMock.mockResolvedValue(false);
    const reply = await call("close_tab", { tab_id: 3 });
    expect(reply.ok).toBe(false);
    if (reply.ok) return;
    expect(reply.error).toContain("was not opened by Atlarix");
  });
});

/**
 * The desktop refused `action:"key"` with "the extension has no key-press op".
 * That was false — `page/trusted-input.ts` has done real CDP keystrokes since
 * the extension shipped, and only the bridge lacked the case. A refusal that
 * misstates a capability is the expensive kind: it sends whoever reads it
 * looking for a feature to build instead of a case to add.
 */
describe("key", () => {
  it("presses a real key on a tab Atlarix opened", async () => {
    const reply = await call("key", { text: "Enter", tab_id: 42 });
    expect(reply.ok).toBe(true);
    expect(attachMock).toHaveBeenCalledWith(42);
    expect(pressKeyMock).toHaveBeenCalledWith(42, "Enter");
  });

  it("refuses the user's own tab, naming the banner and the way round it", async () => {
    isAgentTabMock.mockResolvedValue(false);
    const reply = await call("key", { text: "Enter", tab_id: 3 });
    expect(reply.ok).toBe(false);
    if (reply.ok) return;
    expect(reply.error).toContain("banner");
    expect(reply.error).toContain("click the control");
    expect(attachMock).not.toHaveBeenCalled();
  });

  it("lists the keys it knows rather than failing blankly", async () => {
    const reply = await call("key", { text: "F13", tab_id: 42 });
    expect(reply.ok).toBe(false);
    if (reply.ok) return;
    expect(reply.error).toContain("Enter");
  });
});

describe("hover", () => {
  it("resolves first, then moves a real pointer", async () => {
    runInPage.mockResolvedValue({ ok: true, rect: { x: 10, y: 20 }, label: "Menu" });
    const reply = await call("hover", { ref: "e5", tab_id: 42 });
    expect(reply.ok).toBe(true);
    expect(pageOpCalls()[0][1]).toMatchObject({ op: "resolve", ref: "e5", cursor: "hover" });
    expect(movePointerMock).toHaveBeenCalledWith(42, 10, 20);
  });

  it("does not attach a debugger when the element was not found", async () => {
    runInPage.mockResolvedValue({ ok: false, error: "no such ref" });
    expect((await call("hover", { ref: "e9", tab_id: 42 })).ok).toBe(false);
    expect(attachMock).not.toHaveBeenCalled();
  });
});

/**
 * THE INDICATOR. The owner drove their own browser through this bridge and saw
 * nothing — no frame, no group title. The panel's agent has shown one since it
 * shipped; the bridge never called the op. Reads are covered on purpose: the
 * test that exposed this was a READ.
 */
describe("every page op says so on the page", () => {
  it.each([
    ["read_page", {}],
    ["text", {}],
    ["find_on_page", { query: "x" }],
    ["click", { ref: "e1" }],
    ["fill", { ref: "e1", value: "v" }],
    ["scroll", { direction: "down" }],
  ])("%s raises the overlay", async (op, args) => {
    runInPage.mockResolvedValue({ ok: true, text: "t", clipped: false });
    await call(op, args);
    const overlay = runInPage.mock.calls.find(
      (c) => (c[1] as { op?: string })?.op === "overlay",
    );
    expect(overlay, `${op} did not raise the overlay`).toBeTruthy();
    expect(overlay![1]).toMatchObject({ op: "overlay", state: "on" });
  });

  it("retitles the group while it works", async () => {
    runInPage.mockResolvedValue({ ok: true, text: "t", clipped: false });
    await call("read_page", {});
    expect(setGroupTitleMock).toHaveBeenCalledWith(expect.any(Number), "Atlarix · working");
  });

  it("does not fail the action when the page refuses decoration", async () => {
    runInPage.mockImplementation(async (_t: number, req: { op: string }) => {
      if (req.op === "overlay") throw new Error("cannot inject here");
      return { ok: true, text: "the page", clipped: false };
    });
    expect((await call("text", {})).ok).toBe(true);
  });
});

/**
 * Capture has to START when the tab does.
 *
 * Console and network are PUSHED events, so a buffer opened at read time is
 * empty for a page that has already loaded and logged — and that empty read is
 * indistinguishable from a clean page. These assert the lifecycle rather than
 * the reads, because getting the lifecycle wrong produces a feature that looks
 * like it works and silently reports nothing.
 */
describe("capture follows the tab lifecycle", () => {
  it("starts watching a tab it opens", async () => {
    tabsCreate.mockResolvedValue({ id: 9, windowId: 1 });
    await call("open_tab", { url: "https://x.test/" });
    expect(beginCaptureMock).toHaveBeenCalledWith(9);
    expect(armNetworkMock).toHaveBeenCalledWith(9);
  });

  it("starts watching a tab it navigates", async () => {
    tabsQuery.mockResolvedValue([{ id: 42 }]);
    isAgentTabMock.mockImplementation(async (id: number) => id === 42);
    await call("navigate", { url: "https://x.test/" });
    expect(beginCaptureMock).toHaveBeenCalledWith(42);
  });

  it("stops watching before it closes a tab", async () => {
    await call("close_tab", { tab_id: 42 });
    expect(endCaptureMock).toHaveBeenCalledWith(42);
  });
});

describe("console and network ops", () => {
  it("passes the unavailable reason straight through", async () => {
    readConsoleMock.mockReturnValue({
      entries: [],
      unavailable: "Another debugger is already attached",
    });
    const reply = await call("console", { tab_id: 42 });
    expect(reply.ok).toBe(true);
    if (!reply.ok) return;
    expect((reply.result as { unavailable: string }).unavailable).toContain(
      "Another debugger",
    );
  });

  it("re-arms network on read, for a tab captured before it navigated", async () => {
    await call("network", { tab_id: 42 });
    expect(armNetworkMock).toHaveBeenCalledWith(42);
  });

  it("runs with no permission check, like every other bridged op", async () => {
    const reply = await call("console", { tab_id: 42 });
    expect(reply.ok).toBe(true);
    expect(readConsoleMock).toHaveBeenCalled();
  });
});

describe("screenshot", () => {
  it("photographs the agent's own tab over CDP, without taking focus", async () => {
    const r = await call("screenshot");
    expect(r.ok).toBe(true);
    expect(captureScreenshotMock).toHaveBeenCalledWith(7);
    expect(captureVisibleTabMock).not.toHaveBeenCalled();
    expect(tabsUpdate).not.toHaveBeenCalled();
    expect((r as { result: Record<string, unknown> }).result).toMatchObject({
      mimeType: "image/png",
      data: "AAAA",
      width: 1280,
    });
  });

  it("uses captureVisibleTab for the user's tab only while it is on screen", async () => {
    isAgentTabMock.mockResolvedValue(false);
    tabsGet.mockResolvedValue({ id: 7, url: "https://x.dev/", windowId: 1, active: true });
    const r = await call("screenshot", { tab_id: 7 });
    expect(r.ok).toBe(true);
    expect(captureVisibleTabMock).toHaveBeenCalledWith(1, { format: "png" });
    expect((r as { result: { data: string } }).result.data).toBe("BBBB");
    expect(captureScreenshotMock).not.toHaveBeenCalled();
  });

  it("refuses the user's background tab rather than switching to it", async () => {
    isAgentTabMock.mockResolvedValue(false);
    tabsGet.mockResolvedValue({ id: 7, url: "https://x.dev/", windowId: 1, active: false });
    const r = await call("screenshot", { tab_id: 7 });
    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).toMatch(/never does/);
    expect(tabsUpdate).not.toHaveBeenCalled();
    expect(captureVisibleTabMock).not.toHaveBeenCalled();
  });
});

/**
 * v14.52.0: the extension is the agent's ONLY browser, so the reports the
 * in-app browser used to produce have to come from here.
 */
describe("visual, design and network_body", () => {
  it("visual injects axe from the packaged file, then runs the report", async () => {
    runPageFunctionMock.mockResolvedValue({ url: "https://example.com/", defects: [] });
    const reply = await call("visual", { tab_id: 7 });
    expect(reply.ok).toBe(true);
    expect(injectPackagedFileMock).toHaveBeenCalledWith(7, "vendor/axe.min.js");
    expect(runPageFunctionMock).toHaveBeenCalledTimes(1);
    if (!reply.ok) return;
    expect(reply.result).toMatchObject({ tabId: 7, raw: { defects: [] } });
  });

  it("visual still runs when axe cannot be injected", async () => {
    injectPackagedFileMock.mockResolvedValue(false);
    runPageFunctionMock.mockResolvedValue({ defects: [], axeAvailable: false });
    const reply = await call("visual", { tab_id: 7 });
    expect(reply.ok).toBe(true);
  });

  it("design returns the snapshot", async () => {
    runPageFunctionMock.mockResolvedValue({ palette: [], layout: [] });
    const reply = await call("design", { tab_id: 7 });
    expect(reply.ok).toBe(true);
    if (!reply.ok) return;
    expect(reply.result).toMatchObject({ tabId: 7, snapshot: { palette: [] } });
  });

  it("network_body asks the capture for that request's body", async () => {
    readNetworkBodyMock.mockResolvedValue({ body: "{}", base64: false });
    const reply = await call("network_body", { tab_id: 7, request_id: "r1" });
    expect(reply.ok).toBe(true);
    expect(readNetworkBodyMock).toHaveBeenCalledWith(7, "r1");
  });
});
