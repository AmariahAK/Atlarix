import { describe, expect, it, vi, beforeEach } from "vitest";

const searchMock = vi.fn();
vi.mock("@/lib/search/bm25_semantic_index", () => ({
  searchBlueprintBm25: (...a: unknown[]) => searchMock(...a),
}));

import { rankGrepHitsByBlueprint } from "@/lib/blueprint/grep-blueprint-reranker";

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
