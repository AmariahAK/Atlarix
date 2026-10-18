import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  browser: false,
  paid: true,
  reply: null as Response | null,
  posts: 0,
}));

vi.mock("@/lib/search/browser-search", () => ({
  isBrowserSearchAvailable: () => state.browser,
}));
vi.mock("@/lib/core/paid-core", () => ({
  paidCoreForChat: async () => state.paid,
  coreProxyPost: async () => {
    state.posts += 1;
    return state.reply;
  },
}));

import { paidWebSearch } from "@/lib/search/paid-search";

const ok = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });

beforeEach(() => {
  state.browser = false;
  state.paid = true;
  state.reply = ok({ results: [{ title: "Vite 8", url: "https://vite.dev/blog/announcing-vite8", snippet: "(2026-03-12) Out." }] });
  state.posts = 0;
});

describe("paid web search", () => {
  it("runs through the proxy on a paid turn where there is no hidden browser (terminal, editors, headless)", async () => {
    const r = await paidWebSearch("vite 8", 5, 1);
    expect(state.posts).toBe(1);
    expect(r).toMatchObject({ results: [{ url: "https://vite.dev/blog/announcing-vite8", source: "atlarix" }] });
  });

  it("never calls the proxy where the desktop's own browser can search", async () => {
    state.browser = true;
    expect(await paidWebSearch("vite 8", 5, 1)).toBeNull();
    expect(state.posts).toBe(0);
  });

  it("never calls the proxy for a turn that isn't paid Core (free Auto, your own key)", async () => {
    state.paid = false;
    expect(await paidWebSearch("vite 8", 5, 1)).toBeNull();
    expect(state.posts).toBe(0);
  });

  it("says the balance is why when the proxy answers 402, and null for any other failure", async () => {
    state.reply = new Response(JSON.stringify({ error: "insufficient_credit" }), { status: 402 });
    expect(await paidWebSearch("vite 8", 5, 1)).toEqual({ blocked: "balance" });
    state.reply = new Response("{}", { status: 502 });
    expect(await paidWebSearch("vite 8", 5, 1)).toBeNull();
  });
});
