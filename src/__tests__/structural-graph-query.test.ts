import { describe, expect, it } from "vitest";
import { bfsSymbolGraph } from "../lib/blueprint/rte/ast-grep/graph-bfs";

describe("structural-graph BFS", () => {
  const edges = [
    { from: "a", to: "b", type: "calls", label: "b" },
    { from: "b", to: "c", type: "calls", label: "c" },
    { from: "x", to: "a", type: "imports", label: "./a" },
  ];

  it("finds callers with reverse BFS", () => {
    const result = bfsSymbolGraph(["b"], edges, {
      direction: "reverse",
      edgeTypes: new Set(["calls"]),
      maxDepth: 2,
      maxNodes: 20,
    });
    expect([...result.nodes]).toContain("a");
    expect([...result.nodes]).not.toContain("c");
  });

  it("finds callees with forward BFS", () => {
    const result = bfsSymbolGraph(["a"], edges, {
      direction: "forward",
      edgeTypes: new Set(["calls"]),
      maxDepth: 2,
      maxNodes: 20,
    });
    expect([...result.nodes]).toEqual(expect.arrayContaining(["b", "c"]));
  });

  it("respects max depth", () => {
    const result = bfsSymbolGraph(["a"], edges, {
      direction: "forward",
      edgeTypes: new Set(["calls"]),
      maxDepth: 1,
      maxNodes: 20,
    });
    expect([...result.nodes]).toContain("b");
    expect([...result.nodes]).not.toContain("c");
  });
});
