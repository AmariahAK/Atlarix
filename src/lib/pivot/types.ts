/**
 * PIVOT types — canonical model for Code to Canvas, Canvas to Code.
 * Aligns with shared/blueprint-types where needed for UI mapping.
 */

export type PivotNodeType = "file" | "function" | "class" | "module";

export type PivotEdgeType = "import" | "call" | "extends" | "api";

/** Extracted node (file, function, class, module) from parsers. */
export interface PivotNode {
  id: string;
  type: PivotNodeType;
  label: string;
  filePath: string;
  rangeStart?: number;
  rangeEnd?: number;
  metadata?: Record<string, unknown>;
}

/** Edge between two nodes (import, call, extends). */
export interface PivotEdge {
  id: string;
  fromId: string;
  toId: string;
  type: PivotEdgeType;
  metadata?: Record<string, unknown>;
}

/** Container = top-level diagram node (maps to BlueprintRoom). */
export interface Container {
  id: string;
  workspaceId: number;
  label: string;
  intent?: string;
  position?: { x: number; y: number };
  createdAt?: number;
}

/** Beacon = function/feature inside a container (maps to BlueprintFunction). */
export interface Beacon {
  id: string;
  containerId: string;
  label: string;
  kind: "api" | "webhook" | "function" | "feature";
  description?: string;
  filePath?: string;
  position?: { x: number; y: number };
}

/** Full PIVOT blueprint: containers + beacons + optional raw nodes/edges. */
export interface PivotBlueprint {
  containers: Container[];
  beacons: Beacon[];
  nodes?: PivotNode[];
  edges?: PivotEdge[];
}

/** Source of a blueprint snapshot. */
export type BlueprintSnapshotSource = "rte" | "user" | "ai_cluster";

/** Parsed project result from Stage 1 (parsers). */
export interface ParsedProject {
  nodes: PivotNode[];
  edges: PivotEdge[];
  framework?: string;
  language?: string;
}
