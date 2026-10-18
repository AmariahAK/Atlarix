import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ paid: null as unknown, free: [] as unknown[] }));

vi.mock("@/lib/search/paid-search", () => ({ paidWebSearch: async () => state.paid }));
vi.mock("@/lib/search", () => ({ smartSearch: async () => state.free }));

import { ToolRegistry } from "@/lib/tools/registry";
import "@/lib/tools/web";

const search = async (query: string) =>
  (await ToolRegistry.get("web_search")!.handler({ query } as never)) as { text: string; sources: unknown[] };

beforeEach(() => {
  state.paid = null;
  state.free = [];
});

describe("web_search when the account can't pay for search", () => {
  it("says the balance is why, not that nothing exists, when the free fallback also finds nothing", async () => {
    state.paid = { blocked: "balance" };
    const r = await search("vite 8 esm require condition");
    expect(r.sources).toEqual([]);
    expect(r.text).toContain("balance can't cover it");
    expect(r.text).toContain("/billing");
  });

  it("still returns what the free fallback found", async () => {
    state.paid = { blocked: "balance" };
    state.free = [{ title: "Vite 8 ESM require condition", url: "https://vite.dev/guide/esm-require", snippet: "How Vite 8 resolves the require condition for ESM packages.", score: 30 }];
    // A query of its own: the tool caches results per query.
    const r = await search("vite 8 esm require condition guide");
    expect(r.sources).toHaveLength(1);
    expect(r.text).not.toContain("balance can't cover it");
  });

  it("says nothing about the balance when paid search simply didn't apply", async () => {
    const r = await search("electron 43 breaking changes");
    expect(r.text).not.toContain("balance can't cover it");
  });
});
