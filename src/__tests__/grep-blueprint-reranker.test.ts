import { describe, expect, it, vi, beforeEach } from "vitest";

const searchMock = vi.fn();
vi.mock("@/lib/search/bm25_semantic_index", () => ({
  searchBlueprintBm25: (...a: unknown[]) => searchMock(...a),
}));

import {
  rankGrepHitsByBlueprint,
  suggestClosestIndexedSymbols,
} from "@/lib/blueprint/grep-blueprint-reranker";

const g = (file: string) => ({ file, matches: [{ line: 1, content: "x" }] });

describe("rankGrepHitsByBlueprint", () => {
  beforeEach(() => searchMock.mockReset());

  it("reorders file groups by Blueprint (BM25) relevance, most relevant first", async () => {
    searchMock.mockResolvedValue({
      hits: [
        { score: 9, file: "/ws/src/billing/webhook.ts", line: 10, content: "", contextBefore: [], contextAfter: [] },
        { score: 2, file: "/ws/src/util/log.ts", line: 3, content: "", contextBefore: [], contextAfter: [] },
      ],
      totalMatches: 2,
      filesIndexed: 10,
    });
    const groups = [g("/ws/src/util/log.ts"), g("/ws/src/billing/webhook.ts"), g("/ws/src/misc/other.ts")];
    const out = await rankGrepHitsByBlueprint(groups, {
      workspaceId: 1,
      workspaceRootAbs: "/ws",
      query: "subscription webhook",
    });
    expect(out.map((x) => x.file)).toEqual([
      "/ws/src/billing/webhook.ts", // highest BM25 score
      "/ws/src/util/log.ts", // next
      "/ws/src/misc/other.ts", // unranked (score 0) keeps original position last
    ]);
  });

  it("restricts the Blueprint search to the ripgrep candidate files (candidate-set rerank)", async () => {
    searchMock.mockResolvedValue({ hits: [], totalMatches: 0, filesIndexed: 0 });
    const groups = [g("/ws/a.ts"), g("/ws/b.ts"), g("/ws/c.ts")];
    await rankGrepHitsByBlueprint(groups, {
      workspaceId: 1,
      workspaceRootAbs: "/ws",
      query: "q",
    });
    const [, , , maxResults, opts] = searchMock.mock.calls[0];
    expect(maxResults).toBe(500);
    expect(opts).toEqual({ restrictToFiles: ["/ws/a.ts", "/ws/b.ts", "/ws/c.ts"] });
  });

  it("returns original order when Blueprint has no hits", async () => {
    searchMock.mockResolvedValue({ hits: [], totalMatches: 0, filesIndexed: 0 });
    const groups = [g("/ws/a.ts"), g("/ws/b.ts")];
    const out = await rankGrepHitsByBlueprint(groups, { workspaceId: 1, workspaceRootAbs: "/ws", query: "q" });
    expect(out.map((x) => x.file)).toEqual(["/ws/a.ts", "/ws/b.ts"]);
  });

  it("never calls Blueprint (and is a no-op) without workspace context or with ≤1 group", async () => {
    const single = [g("/ws/a.ts")];
    expect(await rankGrepHitsByBlueprint(single, { query: "q" })).toBe(single);
    const groups = [g("/ws/a.ts"), g("/ws/b.ts")];
    expect(await rankGrepHitsByBlueprint(groups, { query: "q" })).toBe(groups);
    expect(searchMock).not.toHaveBeenCalled();
  });

  it("returns original order when the Blueprint index is unavailable (null)", async () => {
    searchMock.mockResolvedValue(null);
    const groups = [g("/ws/a.ts"), g("/ws/b.ts")];
    const out = await rankGrepHitsByBlueprint(groups, { workspaceId: 1, workspaceRootAbs: "/ws", query: "q" });
    expect(out.map((x) => x.file)).toEqual(["/ws/a.ts", "/ws/b.ts"]);
  });

});

describe("suggestClosestIndexedSymbols (v13.2 zero-hit fallback)", () => {
  beforeEach(() => searchMock.mockReset());

  it("formats top hits as workspace-relative one-liners, deduped by file", async () => {
    searchMock.mockResolvedValue({
      hits: [
        { score: 9, file: "/ws/src/auth/login.ts", line: 42, content: "export function handleAuthCallback() {", contextBefore: [], contextAfter: [] },
        { score: 8, file: "/ws/src/auth/login.ts", line: 99, content: "dupe same file", contextBefore: [], contextAfter: [] },
        { score: 5, file: "/ws/src/auth/session.ts", line: 7, content: "renewSession()", contextBefore: [], contextAfter: [] },
      ],
      totalMatches: 3,
      filesIndexed: 10,
    });
    const out = await suggestClosestIndexedSymbols({
      workspaceId: 1,
      workspaceRootAbs: "/ws",
      query: "auth callback",
    });
    expect(out).toContain("Closest indexed symbols");
    expect(out).toContain("src/auth/login.ts:42");
    expect(out).toContain("handleAuthCallback");
    expect(out).toContain("src/auth/session.ts:7");
    // deduped: second login.ts hit dropped
    expect(out).not.toContain(":99");
  });

  it("caps suggestions at maxSuggestions distinct files", async () => {
    searchMock.mockResolvedValue({
      hits: Array.from({ length: 20 }, (_, i) => ({
        score: 20 - i,
        file: `/ws/src/f${i}.ts`,
        line: i + 1,
        content: "x",
        contextBefore: [],
        contextAfter: [],
      })),
      totalMatches: 20,
      filesIndexed: 30,
    });
    const out = await suggestClosestIndexedSymbols({
      workspaceId: 1,
      workspaceRootAbs: "/ws",
      query: "anything",
      maxSuggestions: 3,
    });
    const lineCount = (out ?? "").split("\n").length;
    expect(lineCount).toBe(4); // header + 3 suggestions
  });

  it("returns null on no hits, null search result, or missing workspace", async () => {
    searchMock.mockResolvedValue({ hits: [], totalMatches: 0, filesIndexed: 0 });
    expect(
      await suggestClosestIndexedSymbols({ workspaceId: 1, workspaceRootAbs: "/ws", query: "q" }),
    ).toBeNull();
    searchMock.mockResolvedValue(null);
    expect(
      await suggestClosestIndexedSymbols({ workspaceId: 1, workspaceRootAbs: "/ws", query: "q" }),
    ).toBeNull();
    expect(await suggestClosestIndexedSymbols({ query: "q" })).toBeNull();
  });
});
