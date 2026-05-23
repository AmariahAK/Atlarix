/**
 * BFS over symbol-level blueprint flow edges.
 */

export type SymbolEdge = {
  from: string;
  to: string;
  label?: string;
  type?: string;
};

export type BfsResult = {
  nodes: Set<string>;
  edges: SymbolEdge[];
  depth: number;
};

function normalizeEdgeType(t?: string): string {
  if (!t) return "call";
  if (t === "imports") return "import";
  return t;
}

function edgeMatchesDirection(
  edge: SymbolEdge,
  direction: "forward" | "reverse",
  edgeTypes: Set<string>,
): boolean {
  const t = normalizeEdgeType(edge.type);
  if (!edgeTypes.has(t)) return false;
  return true;
}

/**
 * BFS from start node ids. `direction`: forward follows from→to; reverse follows to→from.
 */
export function bfsSymbolGraph(
  startIds: string[],
  allEdges: SymbolEdge[],
  opts: {
    direction: "forward" | "reverse";
    edgeTypes: Set<string>;
    maxDepth: number;
    maxNodes: number;
  },
): BfsResult {
  const visited = new Set<string>(startIds);
  const resultEdges: SymbolEdge[] = [];
  const edgeKeys = new Set<string>();
  let frontier = [...startIds];
  let depth = 0;

  while (frontier.length > 0 && depth < opts.maxDepth && visited.size < opts.maxNodes) {
    const next: string[] = [];
    for (const nodeId of frontier) {
      for (const e of allEdges) {
        if (!edgeMatchesDirection(e, opts.direction, opts.edgeTypes)) continue;
        const neighbor =
          opts.direction === "forward"
            ? e.from === nodeId
              ? e.to
              : null
            : e.to === nodeId
              ? e.from
              : null;
        if (!neighbor) continue;
        const key = `${e.from}->${e.to}:${e.type ?? ""}`;
        if (!edgeKeys.has(key)) {
          edgeKeys.add(key);
          resultEdges.push(e);
        }
        if (!visited.has(neighbor) && visited.size < opts.maxNodes) {
          visited.add(neighbor);
          next.push(neighbor);
        }
      }
    }
    frontier = next;
    depth += 1;
  }

  return { nodes: visited, edges: resultEdges, depth };
}
