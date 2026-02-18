/**
 * ELK layout engine (runs in main process).
 * Used via IPC from renderer for container canvas and beacon flow layouts.
 * Lazy-load elkjs on first use to avoid "Object.defineProperty called on non-object"
 * when the main process bundle loads (elkjs can assume a browser env in packaged Electron).
 */

let elkInstance: InstanceType<typeof import("elkjs").default> | null = null;

async function getElk(): Promise<InstanceType<typeof import("elkjs").default>> {
  if (elkInstance) return elkInstance;
  const ELK = (await import("elkjs")).default;
  elkInstance = new ELK();
  return elkInstance;
}

export interface LayoutResult {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export async function layoutContainerCanvas(
  rooms: Array<{ id: string }>,
  edges: Array<{ id: string; from: string; to: string }>,
  containerCount: number
): Promise<LayoutResult[]> {
  const direction = containerCount <= 4 ? "RIGHT" : "DOWN";
  const graph = {
    id: "root",
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": direction,
      "elk.spacing.nodeNode": "80",
      "elk.layered.spacing.nodeNodeBetweenLayers": "120",
      "elk.edgeRouting": "ORTHOGONAL",
    },
    children: rooms.map((r) => ({
      id: r.id,
      width: 220,
      height: 120,
    })),
    edges: edges.map((e) => ({
      id: e.id,
      sources: [e.from],
      targets: [e.to],
    })),
  };

  const elk = await getElk();
  const result = await elk.layout(graph);
  return (result.children ?? []).map((n) => ({
    id: n.id,
    x: n.x ?? 0,
    y: n.y ?? 0,
    width: n.width ?? 220,
    height: n.height ?? 120,
  }));
}

export async function layoutBeaconFlow(
  beacons: Array<{ id: string }>,
  flowEdges: Array<{ id: string; from: string; to: string }>
): Promise<LayoutResult[]> {
  const hasIncoming = new Set(flowEdges.map((e) => e.to));
  const roots = beacons.filter((b) => !hasIncoming.has(b.id));
  const nonRoots = beacons.filter((b) => hasIncoming.has(b.id));

  const graph = {
    id: "room-root",
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": "DOWN",
      "elk.spacing.nodeNode": "56",
      "elk.layered.spacing.nodeNodeBetweenLayers": "100",
      "elk.layered.spacing.edgeNodeBetweenLayers": "40",
      "elk.edgeRouting": "ORTHOGONAL",
      "elk.layered.nodePlacement.strategy": "BRANDES_KOEPF",
    },
    children: beacons.map((b) => ({
      id: b.id,
      width: 180,
      height: 64,
    })),
    edges: flowEdges.map((e) => ({
      id: e.id,
      sources: [e.from],
      targets: [e.to],
    })),
  };

  try {
    const elk = await getElk();
    const result = await elk.layout(graph);
    return (result.children ?? []).map((n) => ({
      id: n.id,
      x: n.x ?? 0,
      y: n.y ?? 0,
      width: n.width ?? 180,
      height: n.height ?? 64,
    }));
  } catch {
    const positions: LayoutResult[] = [];
    roots.forEach((r, i) => {
      positions.push({ id: r.id, x: i * 240, y: 0, width: 180, height: 64 });
    });
    nonRoots.forEach((n, i) => {
      positions.push({
        id: n.id,
        x: (i % 3) * 240,
        y: Math.floor(i / 3) * 100 + 120,
        width: 180,
        height: 64,
      });
    });
    return positions;
  }
}
