/**
 * Web search through the user's own Chrome via the extension (chrome-search.ts),
 * the CLI's search. A tier: results, or [] — never a throw.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const bridgeState: { endpoint: unknown } = { endpoint: null };
vi.mock("@/main/bridge-lifecycle", () => ({ bridge: () => bridgeState.endpoint }));
import { chromeSearch } from "@/lib/search/chrome-search";

afterEach(() => {
  bridgeState.endpoint = null;
});

describe("search through the user's Chrome", () => {
  it("asks the extension's search op and ranks what it read", async () => {
    const request = vi.fn(async () => ({ engine: "brave", results: [{ title: "R", url: "https://r.dev", snippet: "s" }], challenged: false }));
    bridgeState.endpoint = { connected: true, request };
    expect(await chromeSearch("bun compile", 8)).toEqual([{ title: "R", url: "https://r.dev", snippet: "s", score: 1, source: "chrome:brave" }]);
    expect(request).toHaveBeenCalledWith("search", { query: "bun compile", max: 8 }, expect.any(Number));
  });

  it("no browser connected, or an extension older than the op: no results", async () => {
    expect(await chromeSearch("q")).toEqual([]);
    bridgeState.endpoint = { connected: true, request: vi.fn(async () => Promise.reject(new Error('the browser extension has no bridged op "search"'))) };
    expect(await chromeSearch("q")).toEqual([]);
  });
});
