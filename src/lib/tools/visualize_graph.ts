/**
 * visualize_graph — validate nodes/edges and return a ```graph fence for chat.
 */

import {
  ToolRegistry,
  ToolCategory,
  createParameters,
  stringParam,
} from "./registry";
import {
  parseGraphSpec,
  formatGraphFence,
  type GraphSpec,
} from "@/lib/visual-artifacts/graph-spec";

ToolRegistry.register({
  name: "visualize_graph",
  category: ToolCategory.SEARCH_INTELLIGENCE,
  description:
    "Validate an architecture/flow graph (nodes + edges JSON) and return a ```graph fence to embed in your reply. " +
    "Use when a relationship diagram helps explain structure, flows, or dependencies.",
  cost: 1,
  requiresWorkspace: false,
  isCore: false,
  isReadOnly: true,
  allowInAskMode: true,
  parameters: createParameters(
    {
      title: stringParam("Optional short title for the diagram card"),
      graph_json: stringParam(
        'JSON: { "nodes": [{ "id": "a", "name": "Label" }], "edges": [{ "source": "a", "target": "b" }] }',
      ),
    },
    ["graph_json"],
  ),
  handler: async ({
    title,
    graph_json,
  }: {
    title?: string;
    graph_json: string;
  }) => {
    let raw = graph_json.trim();
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      if (title && typeof title === "string") {
        parsed.title = title;
      }
      raw = JSON.stringify(parsed);
    } catch {
      return {
        success: false,
        error: "graph_json must be valid JSON with nodes and edges arrays.",
      };
    }

    const spec = parseGraphSpec(raw);
    if (!spec) {
      return {
        success: false,
        error: "Invalid graph: need at least one node; edges must reference node ids.",
      };
    }

    const fence = formatGraphFence(spec);
    return {
      success: true,
      title: spec.title,
      nodeCount: spec.nodes.length,
      edgeCount: spec.edges.length,
      fence,
      instruction:
        "Copy the fence field into your assistant reply verbatim so Atlarix renders the graph inline.",
    };
  },
});

export type VisualizeGraphResult = {
  success: boolean;
  fence?: string;
  spec?: GraphSpec;
  error?: string;
};
