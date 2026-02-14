/**
 * Blueprint (Architecture JSON) types
 * Used for Blueprint mode in Diagram tab and AI tools.
 */

export type BlueprintFunctionKind = "api" | "webhook" | "function" | "feature";

export interface BlueprintFunction {
  id: string;
  name: string;
  kind: BlueprintFunctionKind;
  /** Optional description or route path */
  description?: string;
  /** Env key for API/Webhook (e.g. OPENROUTER_API_KEY). Shown in list; edit in Creds/Vault. */
  credentialKey?: string;
  /** API provider (e.g. OpenRouter, Stripe). */
  provider?: string;
  /** Webhook trigger (e.g. POST /api/send-email). */
  trigger?: string;
  /** When true, this beacon was created by AI from a container-level prompt; devs can modify or remove. */
  aiGenerated?: boolean;
}

/** Edge between two functions within a room (Phase C/D: flow view) */
export interface BlueprintRoomFlowEdge {
  from: string; // function id
  to: string;   // function id
  label?: string;
}

export interface BlueprintRoom {
  id: string;
  label: string;
  type?: string;
  path?: string;
  intent?: string;
  functions: BlueprintFunction[];
  /** Edges between functions inside this room (calls/triggers). Phase C/D. */
  flowEdges?: BlueprintRoomFlowEdge[];
}

export interface BlueprintEdge {
  from: string;
  to: string;
  label?: string;
}

export interface Blueprint {
  rooms: BlueprintRoom[];
  edges: BlueprintEdge[];
  /** Optional env var names referenced (no values) */
  envRefs?: string[];
}

export function createEmptyBlueprint(): Blueprint {
  return { rooms: [], edges: [], envRefs: [] };
}

export function generateBlueprintId(): string {
  return `bp_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

/**
 * Convert Blueprint to Mermaid graph string for preview
 */
export function blueprintToMermaid(b: Blueprint): string {
  const lines: string[] = ["graph TB"];
  const safe = (id: string) => id.replace(/[^a-zA-Z0-9_]/g, "_");
  for (const room of b.rooms) {
    const label = room.label.replace(/"/g, "'");
    lines.push(`  ${safe(room.id)}["${label}"]`);
  }
  for (const edge of b.edges) {
    const from = safe(edge.from);
    const to = safe(edge.to);
    const link = edge.label ? ` -->|${edge.label}| ` : " --> ";
    lines.push(`  ${from}${link}${to}`);
  }
  return lines.join("\n");
}

// --- Combined Blueprint (v2.2: polyrepo / monorepo) ---

/** Minimal node shape for combined blueprint (matches RTE BlueprintNode) */
export interface BlueprintNodeSummary {
  id: string;
  type: string;
  name: string;
  file: string;
  line?: number;
  description?: string;
  method?: string;
  path?: string;
}

export type ProjectMarker = "frontend" | "backend" | "mobile" | "shared" | "api";

export interface ProjectBlueprint {
  id: string;
  name: string;
  path: string;
  language: string;
  framework?: string;
  marker: ProjectMarker;
  nodes: BlueprintNodeSummary[];
}

export interface CrossProjectEdge {
  from: string; // "projectId:nodeId"
  to: string;   // "projectId:nodeId"
  type: "api_call" | "imports" | "calls";
  method?: string;
  path?: string;
}

export interface CombinedBlueprint {
  version: "2.2";
  type: "combined" | "single";
  projects: ProjectBlueprint[];
  cross_project_edges: CrossProjectEdge[];
}
