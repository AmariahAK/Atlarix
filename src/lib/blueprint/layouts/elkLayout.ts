/**
 * ELK-based hierarchical layout for Blueprint (containers or beacons).
 * Produces a top-down tree suitable for dependency visualization.
 */

import ELK from "elkjs";
import type { Node, Edge } from "@xyflow/react";

const elk = new ELK();

export interface LayoutNode {
  id: string;
  position: { x: number; y: number };
  data: Record<string, unknown>;
  width?: number;
  height?: number;
}

export interface LayoutEdge {
  id: string;
  source: string;
  target: string;
}

const DEFAULT_WIDTH = 160;
const DEFAULT_HEIGHT = 80;

/**
 * Run ELK layered layout and return nodes with updated positions.
 */
export async function runElkLayout(
  nodes: LayoutNode[],
  edges: LayoutEdge[],
  options?: { direction?: "DOWN" | "RIGHT"; nodeWidth?: number; nodeHeight?: number }
): Promise<{ x: number; y: number }[]> {
  const direction = options?.direction ?? "DOWN";
  const nodeWidth = options?.nodeWidth ?? DEFAULT_WIDTH;
  const nodeHeight = options?.nodeHeight ?? DEFAULT_HEIGHT;

  const elkNodes = nodes.map((n) => ({
    id: n.id,
    width: n.width ?? nodeWidth,
    height: n.height ?? nodeHeight,
  }));

  const elkEdges = edges.map((e) => ({
    id: e.id,
    sources: [e.source],
    targets: [e.target],
  }));

  const graph = {
    id: "root",
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": direction,
      "elk.spacing.nodeNode": "36",
      "elk.layered.spacing.nodeNodeBetweenLayers": "48",
    },
    children: elkNodes,
    edges: elkEdges,
  };

  const result = await elk.layout(graph);
  const rootX = result.x ?? 0;
  const rootY = result.y ?? 0;
  const byId = new Map<string, { x: number; y: number }>();
  if (result.children) {
    for (const c of result.children) {
      byId.set(c.id, {
        x: rootX + (c.x ?? 0),
        y: rootY + (c.y ?? 0),
      });
    }
  }
  return nodes.map((n) => byId.get(n.id) ?? { x: 0, y: 0 });
}

/**
 * Apply ELK layout to React Flow nodes and return nodes with updated positions.
 */
export async function applyElkToReactFlowNodes<T>(
  nodes: Node<T>[],
  edges: Edge[],
  opts?: { direction?: "DOWN" | "RIGHT"; nodeWidth?: number; nodeHeight?: number }
): Promise<Node<T>[]> {
  const layoutNodes: LayoutNode[] = nodes.map((n) => ({
    id: n.id,
    position: n.position,
    data: n.data as Record<string, unknown>,
    width: n.measured?.width ?? opts?.nodeWidth ?? DEFAULT_WIDTH,
    height: n.measured?.height ?? opts?.nodeHeight ?? DEFAULT_HEIGHT,
  }));
  const layoutEdges: LayoutEdge[] = edges.map((e) => ({
    id: e.id,
    source: e.source,
    target: e.target,
  }));
  const positions = await runElkLayout(layoutNodes, layoutEdges, opts);
  return nodes.map((n, i) => ({
    ...n,
    position: positions[i] ?? n.position,
  }));
}
