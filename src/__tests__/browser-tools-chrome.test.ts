/**
 * The desktop browser tools against the Chrome bridge — the ARGUMENTS they send
 * and the TEXT they hand the model.
 *
 * Since v14.52.0 the user's Chrome is the agent's only browser, so every
 * behaviour the in-app browser used to provide has to hold here:
 *   - key/hover actually carry their arguments (they were silently dropped, so
 *     both always failed on the Chrome path);
 *   - console/network default to "since your last navigate" — the one thing
 *     browser_test's baseline gave that a plain read did not;
 *   - one request's headers and body come back through `network_body`;
 *   - the visual report is ranked and worded on the desktop.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const requestMock = vi.fn();
const blockedUrls = new Set<string>();

vi.mock("@/main/bridge-lifecycle", () => ({
  bridge: () => ({ connected: true, request: requestMock }),
}));
vi.mock("@/lib/security/url-policy", () => ({
  assertUrlAllowed: async (url: string) => {
    if (blockedUrls.has(url)) throw new Error(`URL blocked: ${url}`);
    return new URL(url);
  },
}));

import "@/lib/tools/browser";
import { ToolRegistry } from "@/lib/tools/registry";
import { __resetNavigationMarksForTests, resolveSince } from "@/lib/tools/browser";

const browser = (args: Record<string, unknown>) =>
  ToolRegistry.get("browser")!.handler(args as never) as Promise<
    Record<string, unknown>
  >;
const inspect = (args: Record<string, unknown>) =>
  ToolRegistry.get("browser_inspect")!.handler(args as never) as Promise<
    Record<string, unknown>
  >;

beforeEach(() => {
  requestMock.mockReset();
  blockedUrls.clear();
  __resetNavigationMarksForTests();
});

describe("act: the arguments reach the extension", () => {
  it("key sends the key name the extension reads", async () => {
    requestMock.mockResolvedValue({ pressed: "Enter" });
    await browser({ action: "key", text: "Enter", tab_id: 4 });
    expect(requestMock).toHaveBeenCalledWith("key", { tab_id: 4, key: "Enter" });
  });

  it("hover sends the ref", async () => {
    requestMock.mockResolvedValue({ hovered: "Menu" });
    await browser({ action: "hover", ref: "e3", tab_id: 4 });
    expect(requestMock).toHaveBeenCalledWith("hover", { tab_id: 4, ref: "e3" });
  });

  it("a stale target is ignored, not a second browser", async () => {
    requestMock.mockResolvedValue({ ok: true });
    const res = await browser({ action: "click", ref: "e1", target: "app" });
    expect(res.success).toBe(true);
    expect(requestMock).toHaveBeenCalledWith("click", { ref: "e1" });
  });

  it("navigate refuses a URL the policy blocks, before reaching the browser", async () => {
    blockedUrls.add("http://169.254.169.254/");
    const res = await browser({
      action: "navigate",
      url: "http://169.254.169.254/",
    });
    expect(res.success).toBe(false);
    expect(String(res.error)).toContain("URL policy");
    expect(requestMock).not.toHaveBeenCalled();
  });

  it("navigate says where it happened, and when the page was still loading", async () => {
    requestMock.mockResolvedValue({ tabId: 5, loaded: false, navigatedAt: 1 });
    const res = await browser({ action: "navigate", url: "http://localhost:3000/" });
    expect(res.success).toBe(true);
    expect(String(res.note)).toContain("tab group");
    expect(String(res.note)).toContain("still loading");
  });
});

describe("console and network: since your last navigate", () => {
  const entry = (message: string, timestamp: number) => ({
    type: "console-error",
    level: "error",
    message,
    timestamp,
    tabId: 5,
  });

  it("hides what came before the agent's last navigate, and says so", async () => {
    requestMock.mockResolvedValueOnce({ tabId: 5, navigatedAt: 1_000 });
    await browser({ action: "navigate", url: "http://localhost:3000/" });

    requestMock.mockResolvedValueOnce({
      tabId: 5,
      entries: [entry("old page error", 500), entry("new page error", 1_500)],
    });
    const res = await inspect({ mode: "console", tab_id: 5 });
    const content = String(res.content);
    expect(content).toContain("new page error");
    expect(content).not.toContain("old page error");
    expect(content).toContain('since:"all"');
    expect(res.count).toBe(1);
  });

  it('since:"all" shows everything', async () => {
    requestMock.mockResolvedValueOnce({ tabId: 5, navigatedAt: 1_000 });
    await browser({ action: "navigate", url: "http://localhost:3000/" });
    requestMock.mockResolvedValueOnce({
      tabId: 5,
      entries: [entry("old page error", 500), entry("new page error", 1_500)],
    });
    const res = await inspect({ mode: "console", tab_id: 5, since: "all" });
    expect(String(res.content)).toContain("old page error");
    expect(res.count).toBe(2);
  });

  it("a tab the agent never navigated is not filtered", () => {
    expect(resolveSince(undefined, 99)).toBeNull();
    expect(resolveSince("1700000000000", 99)).toBe(1_700_000_000_000);
  });

  it("an unwatched tab is NOT reported as a clean one", async () => {
    requestMock.mockResolvedValueOnce({
      tabId: 5,
      unavailable: "Atlarix could not watch this tab's console: DevTools is open.",
    });
    const res = await inspect({ mode: "console", tab_id: 5 });
    expect(res.success).toBe(false);
    expect(String(res.error)).toContain("NOT an empty result");
  });

  it("network request_id returns that request's headers and body", async () => {
    requestMock.mockResolvedValueOnce({
      tabId: 5,
      entry: {
        id: "r1",
        tabId: 5,
        url: "http://localhost:3000/api",
        method: "POST",
        status: 500,
        startedAt: 1,
        source: "cdp",
        responseHeaders: { "content-type": "application/json" },
      },
      body: '{"error":"boom"}',
      base64: false,
    });
    const res = await inspect({ mode: "network", request_id: "r1", tab_id: 5 });
    expect(requestMock).toHaveBeenCalledWith("network_body", {
      request_id: "r1",
      tab_id: 5,
    });
    const content = String(res.content);
    expect(content).toContain("[500] POST http://localhost:3000/api");
    expect(content).toContain("content-type");
    expect(content).toContain('{"error":"boom"}');
  });
});

describe("visual and design", () => {
  it("ranks and words the visual report on the desktop", async () => {
    requestMock.mockResolvedValueOnce({
      tabId: 5,
      url: "http://localhost:3000/",
      raw: {
        url: "http://localhost:3000/",
        title: "App",
        cls: 0.25,
        elementCount: 40,
        defects: [
          { rule: "collapsed-layout", impact: "moderate", message: "Collapsed." },
        ],
        axeViolations: [
          { rule: "color-contrast", impact: "serious", message: "Low contrast.", count: 3 },
        ],
        axeAvailable: true,
        truncated: false,
      },
    });
    const res = await inspect({ mode: "visual", tab_id: 5 });
    expect(requestMock).toHaveBeenCalledWith("visual", { tab_id: 5 });
    const content = String(res.content);
    // serious before moderate, and CLS called out.
    expect(content.indexOf("color-contrast")).toBeLessThan(
      content.indexOf("collapsed-layout"),
    );
    expect(content).toContain("above the 0.1");
    expect(res.defectCount).toBe(2);
  });

  it("says when the contrast checks did not run, so clean is not over-read", async () => {
    requestMock.mockResolvedValueOnce({
      tabId: 5,
      url: "http://localhost:3000/",
      raw: {
        url: "http://localhost:3000/",
        title: "App",
        cls: 0,
        elementCount: 40,
        defects: [],
        axeViolations: [],
        axeAvailable: false,
        truncated: false,
      },
    });
    const res = await inspect({ mode: "visual", tab_id: 5 });
    expect(String(res.content)).toContain("Contrast and accessible-name checks did not run");
  });

  it("renders the design snapshot", async () => {
    requestMock.mockResolvedValueOnce({
      tabId: 5,
      url: "http://localhost:3000/",
      snapshot: {
        url: "http://localhost:3000/",
        title: "App",
        palette: [{ color: "rgb(0, 0, 0)", count: 9 }],
        fontFamilies: ["Inter"],
        typeScale: ["16px / 400"],
        spacing: ["8px"],
        layout: ["main: 1200×800"],
      },
    });
    const res = await inspect({ mode: "design", tab_id: 5 });
    expect(String(res.content)).toContain("Palette (most-used first): rgb(0, 0, 0) (×9)");
  });
});
