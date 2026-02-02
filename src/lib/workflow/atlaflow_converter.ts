/**
 * Atlaflow Converter - n8n ↔ ReactFlow format
 * Converts between our workflow JSON and ReactFlow's node/edge format.
 * Handles inferred generic nodes (atlaflow.*) with friendly labels for all languages.
 */

import type { Node, Edge } from "@xyflow/react";

/** Friendly display names for inferred atlaflow.* node types (all languages) */
const ATLAFLOW_GENERIC_LABELS: Record<string, string> = {
  "atlaflow.reactApp": "React App",
  "atlaflow.nextApp": "Next.js App",
  "atlaflow.vueApp": "Vue App",
  "atlaflow.apiServer": "API Server",
  "atlaflow.app": "App",
  "atlaflow.pythonApp": "Python App",
  "atlaflow.pythonApi": "FastAPI",
  "atlaflow.djangoApp": "Django App",
  "atlaflow.flaskApp": "Flask App",
  "atlaflow.goApp": "Go App",
  "atlaflow.rustApp": "Rust App",
  "atlaflow.rubyApp": "Ruby App",
  "atlaflow.javaApp": "Java App",
  "atlaflow.phpApp": "PHP App",
  "atlaflow.dotnetApp": ".NET App",
  "atlaflow.denoApp": "Deno App",
  "atlaflow.elixirApp": "Elixir App",
  "atlaflow.module": "Module",
  "atlaflow.entryPoint": "Entry Point",
  "atlaflow.dataSource": "Data Source",
  "atlaflow.screen": "Screen",
  "atlaflow.branch": "Branch",
};

function nodeTypeToLabel(nodeType: string): string {
  if (ATLAFLOW_GENERIC_LABELS[nodeType]) return ATLAFLOW_GENERIC_LABELS[nodeType];
  if (nodeType.startsWith("n8n-nodes-base."))
    return nodeType.replace("n8n-nodes-base.", "");
  if (nodeType.startsWith("atlaflow."))
    return nodeType.replace("atlaflow.", "").replace(/([A-Z])/g, " $1").trim() || nodeType;
  return nodeType;
}

export interface AtlaflowWorkflow {
  nodes: Array<{
    id: string;
    type: string;
    parameters?: Record<string, unknown>;
    position: [number, number];
    /** Optional per-node message / note to AI */
    message?: string;
  }>;
  connections: Record<string, { main: Array<Array<{ node: string }>> }>;
}

/** n8n/Atlaflow workflow → ReactFlow nodes + edges */
export function workflowToReactFlow(workflow: AtlaflowWorkflow): {
  nodes: Node[];
  edges: Edge[];
} {
  const nodes: Node[] = workflow.nodes.map((n) => {
    const params = n.parameters ?? {};
    const label =
      (n.type === "atlaflow.module" || n.type === "atlaflow.entryPoint" || n.type === "atlaflow.dataSource" || n.type === "atlaflow.screen") &&
      typeof params.label === "string"
        ? params.label
        : nodeTypeToLabel(n.type);
    return {
      id: n.id,
      type: "atlaflowNode",
      position: { x: n.position[0] ?? 0, y: n.position[1] ?? 0 },
      data: {
        label,
        nodeType: n.type,
        parameters: params,
        message: n.message ?? "",
      },
    };
  });

  const edges: Edge[] = [];
  for (const [sourceId, conn] of Object.entries(workflow.connections)) {
    const main = conn?.main ?? [];
    for (let outIdx = 0; outIdx < main.length; outIdx++) {
      const outputs = main[outIdx] ?? [];
      for (let i = 0; i < outputs.length; i++) {
        const targetId = outputs[i]?.node;
        if (targetId) {
          edges.push({
            id: `e-${sourceId}-${outIdx}-${targetId}-${i}`,
            source: sourceId,
            target: targetId,
          });
        }
      }
    }
  }

  return { nodes, edges };
}

/** ReactFlow nodes + edges → n8n/Atlaflow workflow */
export function reactFlowToWorkflow(nodes: Node[], edges: Edge[]): AtlaflowWorkflow {
  const workflowNodes = nodes.map((n) => {
    const data = n.data as {
      nodeType?: string;
      label?: string;
      parameters?: Record<string, unknown>;
      message?: string;
    };
    const pos = n.position as { x?: number; y?: number } | undefined;
    const x = typeof pos?.x === "number" ? pos.x : 0;
    const y = typeof pos?.y === "number" ? pos.y : 0;
    return {
      id: n.id,
      type: data?.nodeType ?? `n8n-nodes-base.${data?.label ?? "manual"}`,
      parameters: data?.parameters ?? {},
      position: [x, y] as [number, number],
      ...(data?.message ? { message: data.message } : {}),
    };
  });

  const connections: AtlaflowWorkflow["connections"] = {};
  for (const e of edges) {
    if (!connections[e.source]) {
      connections[e.source] = { main: [[]] };
    }
    const main = connections[e.source].main;
    if (main.length === 0) main.push([]);
    main[0].push({ node: e.target });
  }

  return { nodes: workflowNodes, connections };
}
