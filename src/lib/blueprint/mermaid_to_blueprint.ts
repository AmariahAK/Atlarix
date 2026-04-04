/**
 * Infer a Blueprint (rooms + edges) from Mermaid graph content.
 * Used to auto-fill the Blueprint view from the Live diagram for existing projects.
 */

import type { Blueprint, BlueprintRoom, BlueprintEdge, BlueprintFunction } from "@/shared/blueprint-types";
import { generateBlueprintId } from "@/shared/blueprint-types";
import { prepareMermaidForParse } from "@/lib/normalizeDiagramMermaid";

/** Normalize a Mermaid node id for use as a Blueprint room id (safe, unique) */
function safeId(raw: string): string {
  return raw.replace(/[^a-zA-Z0-9_-]/g, "_").replace(/^_+|_+$/g, "") || "node";
}

/**
 * Parse Mermaid flowchart/graph lines into node ids, labels, and edges.
 * Handles: graph TB/LR, A --> B, A["Label"] --> B, A -->|edge label| B, subgraph, code fence.
 */
export function parseMermaidGraph(mermaidContent: string): {
  nodes: Map<string, string>; // id -> display label
  edges: Array<{ from: string; to: string; label?: string }>;
} {
  const nodes = new Map<string, string>();
  const edges: Array<{ from: string; to: string; label?: string }> = [];
  const content = prepareMermaidForParse(mermaidContent);

  const lines = content
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("%") && !l.startsWith("%%"));

  /** Extract node id and optional label from a string like "Root", "Core[\"Core\"]", "id(label)" */
  function extractNodeRefs(s: string): Array<{ id: string; label: string }> {
    const refs: Array<{ id: string; label: string }> = [];
    const re = /([a-zA-Z0-9_.\u0080-\uFFFF]+)(?:\[(?:["']?)([^\]"']*)(?:["']?)\])?|([a-zA-Z0-9_.\u0080-\uFFFF]+)(?:\(([^)]*)\))?/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(s)) !== null) {
      const id = (m[1] || m[3] || "").trim();
      const label = (m[2] || m[4] || "").trim() || id;
      if (id && !["subgraph", "end", "graph"].includes(id)) {
        refs.push({ id, label });
      }
    }
    return refs;
  }

  const arrowRegex = /(-->|---|-.->|==>|--)/;

  for (const line of lines) {
    const lower = line.toLowerCase();
    if (lower.startsWith("graph ") || lower.startsWith("flowchart ")) continue;
    if (lower === "end") continue;

    // subgraph id or subgraph id["label"] → add as node
    if (lower.startsWith("subgraph ")) {
      const rest = line.slice(9).trim();
      const refs = extractNodeRefs(rest);
      if (refs[0]) nodes.set(safeId(refs[0].id), refs[0].label || refs[0].id);
      continue;
    }

    // class ... → skip (styling)
    if (lower.startsWith("class ")) continue;

    // Edge: something --> something [-->|label| something]
    const arrowMatch = line.match(arrowRegex);
    if (arrowMatch) {
      const arrow = arrowMatch[0];
      const parts = line.split(arrow);
      if (parts.length >= 2) {
        const left = parts[0].trim();
        const rightPart = parts[1].trim();
        const pipeMatch = rightPart.match(/^\|\s*([^|]*)\s*\|\s*(.+)$/);
        const right = pipeMatch ? pipeMatch[2].trim() : rightPart;
        const edgeLabel = pipeMatch ? pipeMatch[1].trim() : undefined;

        const fromRefs = extractNodeRefs(left);
        const toRefs = extractNodeRefs(right);
        const fromId = fromRefs[0]?.id ? safeId(fromRefs[0].id) : null;
        const toId = toRefs[0]?.id ? safeId(toRefs[0].id) : null;
        if (fromRefs[0]) nodes.set(safeId(fromRefs[0].id), fromRefs[0].label || fromRefs[0].id);
        if (toRefs[0]) nodes.set(safeId(toRefs[0].id), toRefs[0].label || toRefs[0].id);
        if (fromId && toId) edges.push({ from: fromId, to: toId, label: edgeLabel });
      }
      continue;
    }

    // Standalone node: id["Label"] or id(Label) or plain id (single token, no arrow)
    const nodeMatch = line.match(/^([a-zA-Z0-9_.\u0080-\uFFFF]+)\[(?:["']?)([^\]"']*)(?:["']?)\]$/);
    if (nodeMatch) {
      const id = safeId(nodeMatch[1]);
      const label = (nodeMatch[2] || nodeMatch[1]).trim();
      nodes.set(id, label);
      continue;
    }
    const nodeParenMatch = line.match(/^([a-zA-Z0-9_.\u0080-\uFFFF]+)\(([^)]*)\)$/);
    if (nodeParenMatch) {
      const id = safeId(nodeParenMatch[1]);
      const label = (nodeParenMatch[2] || nodeParenMatch[1]).trim();
      nodes.set(id, label);
      continue;
    }
    // Plain single-word node (e.g. "Core", "Root", "main_tsx")
    const plainNodeMatch = line.match(/^([a-zA-Z0-9_.\u0080-\uFFFF]+)$/);
    if (plainNodeMatch) {
      const id = plainNodeMatch[1];
      if (!["class", "style", "link", "click"].includes(id.toLowerCase())) {
        nodes.set(safeId(id), id);
      }
    }
  }

  // Ensure every node in edges has an entry (label = id)
  for (const e of edges) {
    if (!nodes.has(e.from)) nodes.set(e.from, e.from);
    if (!nodes.has(e.to)) nodes.set(e.to, e.to);
  }

  return { nodes, edges };
}

/**
 * Build a Blueprint from parsed Mermaid nodes and edges.
 * Each node becomes a room with one default "feature" function (so the room is editable).
 */
export function inferBlueprintFromMermaid(mermaidContent: string): Blueprint {
  const { nodes, edges } = parseMermaidGraph(mermaidContent);
  if (nodes.size === 0 && edges.length === 0) {
    return { rooms: [], edges: [], envRefs: [] };
  }

  const rooms: BlueprintRoom[] = [];
  const seen = new Set<string>();
  for (const [id, label] of nodes) {
    const safe = safeId(id);
    if (seen.has(safe)) continue;
    seen.add(safe);
    const fnId = generateBlueprintId();
    const fn: BlueprintFunction = {
      id: fnId,
      name: label || id,
      kind: "feature",
      description: undefined,
    };
    rooms.push({
      id: `room_${safe}`,
      label: label || id,
      functions: [fn],
    });
  }

  const blueprintEdges: BlueprintEdge[] = edges.map((e) => ({
    from: rooms.some((r) => r.id === `room_${e.from}`) ? `room_${e.from}` : e.from,
    to: rooms.some((r) => r.id === `room_${e.to}`) ? `room_${e.to}` : e.to,
    label: e.label,
  }));

  // Normalize edge from/to to room ids
  const roomIdByLegacy = new Map<string, string>();
  for (const r of rooms) {
    const legacy = r.id.replace(/^room_/, "");
    roomIdByLegacy.set(legacy, r.id);
  }
  for (const edge of blueprintEdges) {
    if (roomIdByLegacy.has(edge.from)) edge.from = roomIdByLegacy.get(edge.from)!;
    if (roomIdByLegacy.has(edge.to)) edge.to = roomIdByLegacy.get(edge.to)!;
  }

  return { rooms, edges: blueprintEdges, envRefs: [] };
}
