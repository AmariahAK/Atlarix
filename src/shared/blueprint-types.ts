/**
 * Blueprint (Architecture JSON) types
 * Used for Blueprint mode in Diagram tab and AI tools.
 */

export type BlueprintFunctionKind = "api" | "webhook" | "function" | "feature";

export type DescriptionSource = "jsdoc" | "pattern" | "ai" | "ollama";

export interface BlueprintFunction {
  id: string;
  name: string;
  kind: BlueprintFunctionKind;
  /** Optional description or route path (technical, e.g. file path) */
  description?: string;
  /** Human-readable one-liner from JSDoc, pattern, or AI */
  simpleDescription?: string;
  /** Source of simpleDescription */
  descriptionSource?: DescriptionSource;
  /** Env key for API/Webhook (e.g. OPENROUTER_API_KEY). Shown in list; edit in Creds/Vault. */
  credentialKey?: string;
  /** API provider (e.g. OpenRouter, Stripe). */
  provider?: string;
  /** Webhook trigger (e.g. POST /api/send-email). */
  trigger?: string;
  /** When true, this beacon was created by AI from a container-level prompt; devs can modify or remove. */
  aiGenerated?: boolean;
  /** Optional parent beacon id; when set, this is a node (e.g. tool call, step). */
  parentId?: string;
  /** Absolute path to source file (used by file-tree source). */
  file?: string;
  /** v3.6: Enrichment inputs (from balanced model). */
  enrichmentInputs?: string[];
  /** v3.6: Enrichment outputs. */
  enrichmentOutputs?: string[];
  /** v3.6: Enrichment data flows to other nodes. */
  enrichmentDataFlows?: Array<{ to: string; label: string }>;
}

/** Direction of data flow for edge styling (to=red, from=blue, both=purple) */
export type BlueprintEdgeDirection = "to" | "from" | "both";

/** Edge between two functions within a room (Phase C/D: flow view) */
export interface BlueprintRoomFlowEdge {
  id?: string;
  from: string; // function id
  to: string;   // function id
  label?: string;
  type?: "import" | "call" | "api";
  weight?: number;
  /** When true, edge was inferred from imports (not RTE-confirmed). */
  inferred?: boolean;
  /** Data flow direction for path color: to (red), from (blue), both (purple). */
  direction?: BlueprintEdgeDirection;
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
  /** Optional parent container id; when set, this is a packet. */
  parentId?: string;
  /** Optional child container ids for file-tree hierarchy. */
  children?: string[];
  /** When true, room is not shown on canvas (e.g. __deps__). */
  hidden?: boolean;
}

export interface BlueprintEdge {
  id?: string;
  from: string;
  to: string;
  label?: string;
  type?: "import" | "call" | "api";
  weight?: number;
  /** When true, edge was inferred from imports (not RTE-confirmed). */
  inferred?: boolean;
  /** Data flow direction for path color: to (red), from (blue), both (purple). */
  direction?: BlueprintEdgeDirection;
}

export interface Blueprint {
  rooms: BlueprintRoom[];
  edges: BlueprintEdge[];
  /** Optional env var names referenced (no values) */
  envRefs?: string[];
  /** Inferred edge keys (from\\tto) that the user removed; we do not re-add them on merge. */
  removedInferredEdgeKeys?: string[];
}

export function createEmptyBlueprint(): Blueprint {
  return { rooms: [], edges: [], envRefs: [] };
}

export function generateBlueprintId(): string {
  return `bp_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

// v12 2.7: the Combined Blueprint (v2.2 polyrepo) type cluster was deleted
// with the dead codegen/combined-generator subsystem (zero remaining users).
