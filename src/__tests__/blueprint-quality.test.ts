import { describe, expect, it } from "vitest";
import {
  assessBlueprintRichness,
  isThinRteNodeSet,
} from "@/lib/blueprint/blueprint-quality";
import type { Blueprint, BlueprintRoom } from "@/shared/blueprint-types";

function room(id: string, fns: number, hidden = false): BlueprintRoom {
  const functions = Array.from({ length: fns }, (_, i) => ({
    id: `${id}-fn-${i}`,
    name: `fn${i}`,
    kind: "function" as const,
    file: `src/${id}/file${i}.ts`,
  }));
  return { id, label: id, path: id, functions, hidden };
}

function bp(rooms: BlueprintRoom[], edges = 0): Blueprint {
  const visible = rooms.filter((r) => !r.hidden);
  const edgeList =
    edges > 0 && visible.length >= 2
      ? [{ from: visible[0].id, to: visible[1].id, type: "import" as const }]
      : [];
  return { rooms, edges: edgeList, envRefs: [] };
}

describe("assessBlueprintRichness", () => {
  it("classifies few symbols as thin", () => {
    const r = assessBlueprintRichness(bp([room("a", 2), room("b", 3)]));
    expect(r.quality).toBe("thin");
    expect(r.functionCount).toBe(5);
  });

  it("classifies large graphs as rich", () => {
    const rooms = Array.from({ length: 12 }, (_, i) => room(`r${i}`, 5));
    const r = assessBlueprintRichness(bp(rooms, 1));
    expect(r.quality).toBe("rich");
    expect(r.functionCount).toBe(60);
  });

  it("classifies mid-size as moderate", () => {
    const rooms = Array.from({ length: 6 }, (_, i) => room(`r${i}`, 4));
    const r = assessBlueprintRichness(bp(rooms));
    expect(r.quality).toBe("moderate");
  });
});

describe("isThinRteNodeSet", () => {
  it("returns true for few nodes", () => {
    expect(isThinRteNodeSet([{ file: "a.ts" }, { file: "b.ts" }])).toBe(true);
  });

  it("returns false when many unique files", () => {
    const nodes = Array.from({ length: 25 }, (_, i) => ({ file: `src/f${i}.ts` }));
    expect(isThinRteNodeSet(nodes, 200)).toBe(false);
  });
});
