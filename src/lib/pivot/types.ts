/**
 * v2.5 PIVOT — From Code to Canvas, Canvas to Code
 * Types for Containers (high-level components) and Beacons (functionality inside a container).
 * Three states: Live Diagram ↔ Blueprint → Generated Code.
 */

/** Structural node from code (function, class, API, DB, webhook, etc.) */
export interface PivotNode {
  id: string;
  type: "function" | "class" | "api" | "webhook" | "db" | "cron" | "stream" | "3p" | "other";
  label: string;
  filePath?: string;
  startLine?: number;
  endLine?: number;
  frameworkHint?: string;
  /** Env key references (e.g. STRIPE_API_KEY, RESEND_API_KEY) */
  envRefs?: string[];
}

/** Edge between nodes (calls, imports, inherits) */
export interface PivotEdge {
  id: string;
  fromId: string;
  toId: string;
  kind: "calls" | "imports" | "inherits" | "data";
  label?: string;
}

/** Container = high-level architectural component (e.g. Auth API, Payment Service) */
export interface PivotContainer {
  id: string;
  label: string;
  intent?: string;
  type?: "api" | "db" | "worker" | "frontend" | "service";
  nodeIds: string[];
}

/** Beacon = individual functionality inside a container (e.g. Login, Signup, Send Email) */
export interface PivotBeacon {
  id: string;
  containerId: string;
  label: string;
  /** Natural language description; can reference env keys (e.g. "Uses STRIPE_API_KEY") */
  description?: string;
  nodeIds: string[];
  /** Env key names referenced (no values) */
  envRefs?: string[];
}

/** Edge between beacons (flow/sequence) */
export interface PivotBeaconEdge {
  id: string;
  fromBeaconId: string;
  toBeaconId: string;
  label?: string;
}

/** Blueprint snapshot: containers + beacons + optional comparison to live */
export interface PivotBlueprint {
  id: string;
  projectHash?: string;
  containers: PivotContainer[];
  beacons: PivotBeacon[];
  beaconEdges: PivotBeaconEdge[];
  envRefs: string[];
  /** When this snapshot was taken */
  updatedAt: number;
}

export function createEmptyPivotBlueprint(): PivotBlueprint {
  return {
    id: `pivot_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
    containers: [],
    beacons: [],
    beaconEdges: [],
    envRefs: [],
    updatedAt: Date.now(),
  };
}
