import { describe, expect, it } from "vitest";
import { bfsSymbolGraph } from "../lib/blueprint/rte/ast-grep/graph-bfs";

describe("blast-radius graph traversal", () => {
  const edges = [
    { from: "a", to: "b", type: "calls" },
    { from: "c", to: "a", type: "calls" },
    { from: "d", to: "a", type: "imports" },
    { from: "a", to: "e", type: "calls" },
  ];

  it("reverse BFS finds callers and importers", () => {
    const callers = bfsSymbolGraph(["a"], edges, {
      direction: "reverse",
      edgeTypes: new Set(["call", "calls"]),
      maxDepth: 2,
      maxNodes: 20,
    });
    expect(callers.nodes.has("c")).toBe(true);
    expect(callers.nodes.has("d")).toBe(false);

    const importers = bfsSymbolGraph(["a"], edges, {
      direction: "reverse",
      edgeTypes: new Set(["import", "imports"]),
      maxDepth: 2,
      maxNodes: 20,
    });
    expect(importers.nodes.has("d")).toBe(true);
  });

  it("forward BFS finds callees", () => {
    const callees = bfsSymbolGraph(["a"], edges, {
      direction: "forward",
      edgeTypes: new Set(["call", "calls"]),
      maxDepth: 2,
      maxNodes: 20,
    });
    expect(callees.nodes.has("b")).toBe(true);
    expect(callees.nodes.has("e")).toBe(true);
  });
});
