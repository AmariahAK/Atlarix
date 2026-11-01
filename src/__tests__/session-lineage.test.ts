/**
 * Session lineage, the pure part: the order every list of past chats shows them
 * in (each child under its parent), what a row says about where it came from,
 * and the lineage a caller may hand over IPC.
 */
import { describe, expect, it } from "vitest";
import {
  lineageNote,
  orderSessionTree,
  parseSessionLineage,
  parseSessionOrigin,
  treeFirst,
  treeLabel,
} from "@/shared/session-lineage";

const at = (min: number) => new Date(Date.UTC(2026, 9, 29, 10, min));
const row = (id: string, min: number, parentSessionId: string | null = null) => ({ id, parentSessionId, updatedAt: at(min) });
const order = (rows: ReturnType<typeof row>[], limit?: number) =>
  orderSessionTree(rows, limit).map((r) => `${"-".repeat(r.depth)}${r.id}`);

describe("orderSessionTree", () => {
  it("puts each child right under its parent, newest first at every level", () => {
    expect(
      order([row("a", 50), row("b", 40), row("a-fork", 30, "a"), row("a-fork2", 20, "a"), row("deep", 10, "a-fork")]),
    ).toEqual(["a", "-a-fork", "--deep", "-a-fork2", "b"]);
  });

  it("places a tree by its most recently active chat: work in a fork brings it up", () => {
    expect(order([row("b", 40), row("a", 10), row("a-fork", 50, "a")])).toEqual(["a", "-a-fork", "b"]);
  });

  it("lists a chat whose parent is not listed (another folder, deleted) as a root", () => {
    expect(order([row("a", 50), row("orphan", 40, "gone")])).toEqual(["a", "orphan"]);
  });

  it("never loses rows in a parent loop (rows are data)", () => {
    const out = orderSessionTree([row("x", 10, "y"), row("y", 20, "x"), row("a", 5)]);
    expect(out.map((r) => r.id).sort()).toEqual(["a", "x", "y"]);
    expect(out.filter((r) => r.id !== "a").map((r) => r.depth).sort()).toEqual([0, 1]);
  });

  it("keeps `rootLimit` trees, each whole", () => {
    expect(order([row("a", 50), row("a1", 10, "a"), row("b", 40), row("c", 30)], 2)).toEqual(["a", "-a1", "b"]);
  });
});

describe("treeFirst", () => {
  const rows = orderSessionTree([row("a", 50), row("b", 40), row("b1", 30, "b"), row("b2", 20, "b")]);

  it("moves the open chat's whole tree to the top", () => {
    expect(treeFirst(rows, "b2").map((r) => r.id)).toEqual(["b", "b1", "b2", "a"]);
  });

  it("leaves the order alone with no open chat, or one not listed", () => {
    expect(treeFirst(rows, null).map((r) => r.id)).toEqual(["a", "b", "b1", "b2"]);
    expect(treeFirst(rows, "zz").map((r) => r.id)).toEqual(["a", "b", "b1", "b2"]);
  });
});

describe("lineageNote / treeLabel", () => {
  it("says how a child came, and from which chat when listed apart from it", () => {
    expect(lineageNote({ origin: { via: "user" } })).toBeNull();
    expect(lineageNote({ origin: null })).toBeNull();
    expect(lineageNote({ origin: { via: "fork" }, depth: 1 })).toBe("fork");
    expect(lineageNote({ origin: { via: "fork" }, depth: 0, parentTitle: "Plan the API" })).toBe("fork of Plan the API");
    expect(
      lineageNote({ origin: { via: "peer", by: { sessionId: "s", name: "ai-dd", surface: "cli" } }, depth: 1 }),
    ).toBe("from ai-dd");
    expect(lineageNote({ origin: { via: "automation", automationId: "x" }, depth: 1, runs: 24 })).toBe("automation · 24 runs");
    expect(lineageNote({ origin: { via: "automation", automationId: "x" }, depth: 1, runs: 1 })).toBe("automation");
  });

  it("indents a child under its parent", () => {
    expect(treeLabel("Root")).toBe("Root");
    expect(treeLabel("Fork", 1)).toBe("↳ Fork");
    expect(treeLabel("Fork of fork", 2)).toBe("  ↳ Fork of fork");
  });
});

describe("parsing stored and handed-over lineage", () => {
  it("reads a stored origin and drops what it does not know", () => {
    expect(parseSessionOrigin('{"via":"peer","surface":"cli","by":{"sessionId":"s","name":"n","surface":"app"},"x":1}')).toEqual({
      via: "peer",
      surface: "cli",
      by: { sessionId: "s", name: "n", surface: "app" },
    });
    expect(parseSessionOrigin('{"via":"teleport"}')).toBeNull();
    expect(parseSessionOrigin("not json")).toBeNull();
    expect(parseSessionOrigin(null)).toBeNull();
  });

  it("takes a lineage over IPC only with a parent and a real `via`, never its surface", () => {
    expect(parseSessionLineage({ parentSessionId: "p", origin: { via: "peer", surface: "app" } })).toEqual({
      parentSessionId: "p",
      origin: { via: "peer" },
    });
    expect(parseSessionLineage({ parentSessionId: "p", origin: { via: "user" } })).toBeUndefined();
    expect(parseSessionLineage({ origin: { via: "fork" } })).toBeUndefined();
    expect(parseSessionLineage({ parentSessionId: "x".repeat(201), origin: { via: "fork" } })).toBeUndefined();
    expect(parseSessionLineage("fork")).toBeUndefined();
  });
});
