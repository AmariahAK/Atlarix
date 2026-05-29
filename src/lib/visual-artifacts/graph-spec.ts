export type GraphNode = {
  id: string;
  name: string;
  x?: number;
  y?: number;
  symbolSize?: number;
  itemStyle?: { color?: string };
  label?: { color?: string };
};

export type GraphEdge = {
  source: string;
  target: string;
};

export type GraphLayout = "force" | "none";

export type GraphSpec = {
  title?: string;
  layout?: GraphLayout;
  nodes: GraphNode[];
  edges: GraphEdge[];
};

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

function normalizeNode(raw: unknown, index: number): GraphNode | null {
  const o = asRecord(raw);
  if (!o) return null;
  const id = String(o.id ?? o.name ?? `node-${index}`).trim();
  const name = String(o.name ?? o.label ?? id).trim();
  if (!id) return null;
  const node: GraphNode = { id, name: name || id };
  if (typeof o.x === "number" && Number.isFinite(o.x)) node.x = o.x;
  if (typeof o.y === "number" && Number.isFinite(o.y)) node.y = o.y;
  if (typeof o.symbolSize === "number" && o.symbolSize > 0) {
    node.symbolSize = o.symbolSize;
  }
  const itemStyle = asRecord(o.itemStyle);
  if (itemStyle?.color && typeof itemStyle.color === "string") {
    node.itemStyle = { color: itemStyle.color };
  }
  const label = asRecord(o.label);
  if (label?.color && typeof label.color === "string") {
    node.label = { color: label.color };
  }
  return node;
}

function normalizeEdge(raw: unknown): GraphEdge | null {
  const o = asRecord(raw);
  if (!o) return null;
  const source = String(o.source ?? o.from ?? "").trim();
  const target = String(o.target ?? o.to ?? "").trim();
  if (!source || !target) return null;
  return { source, target };
}

const FENCE_GRAPH = /```graph\s*\r?\n([\s\S]*?)```/i;
const FENCE_GENERIC = /```(?:json|graph)?\s*\r?\n([\s\S]*?)```/i;

export function stripGraphCodeFence(raw: string): string {
  let s = raw.replace(/^\uFEFF/, "").trim();
  if (!s.startsWith("```")) return s;
  const firstNl = s.indexOf("\n");
  if (firstNl === -1) return s;
  const body = s.slice(firstNl + 1);
  const close = body.lastIndexOf("```");
  if (close === -1) return s.trim();
  return body.slice(0, close).trim();
}

export function parseGraphSpec(raw: string): GraphSpec | null {
  const trimmed = stripGraphCodeFence(raw.trim());
  if (!trimmed) return null;
  try {
    const data = JSON.parse(trimmed) as Record<string, unknown>;
    const nodesRaw = Array.isArray(data.nodes) ? data.nodes : [];
    const edgesRaw = Array.isArray(data.edges) ? data.edges : [];
    const nodes = nodesRaw
      .map((n, i) => normalizeNode(n, i))
      .filter((n): n is GraphNode => n != null);
    const edges = edgesRaw
      .map((e) => normalizeEdge(e))
      .filter((e): e is GraphEdge => e != null);
    if (nodes.length === 0) return null;
    const layout =
      data.layout === "none" || data.layout === "force"
        ? data.layout
        : nodes.some((n) => n.x != null && n.y != null)
          ? "none"
          : "force";
    return {
      title: typeof data.title === "string" ? data.title.trim() : undefined,
      layout,
      nodes,
      edges,
    };
  } catch {
    return null;
  }
}

export function formatGraphFence(spec: GraphSpec): string {
  const payload = {
    ...(spec.title ? { title: spec.title } : {}),
    nodes: spec.nodes.map(({ id, name }) => ({ id, name })),
    edges: spec.edges.map(({ source, target }) => ({ source, target })),
  };
  return "```graph\n" + JSON.stringify(payload, null, 2) + "\n```";
}

export function serializeGraphSpec(spec: GraphSpec): string {
  return JSON.stringify(
    {
      title: spec.title,
      layout: spec.layout,
      nodes: spec.nodes,
      edges: spec.edges,
    },
    null,
    2,
  );
}

/** Legacy Mermaid rows in DB — skip render until regen. */
export function isLegacyMermaidContent(raw: string): boolean {
  const t = raw.trim();
  if (!t) return false;
  if (t.startsWith("{")) return false;
  return /^(graph\s|flowchart\s|sequenceDiagram|classDiagram|stateDiagram|erDiagram|gantt\b)/im.test(t);
}

export function normalizeDiagramAiOutput(rawText: string): string {
  if (!rawText) return rawText;
  let t = rawText.replace(/^\uFEFF/, "").trim();
  let m = t.match(FENCE_GRAPH);
  if (m) {
    t = m[1].trim();
  } else {
    m = t.match(FENCE_GENERIC);
    if (m) {
      t = m[1].trim();
    }
  }
  const spec = parseGraphSpec(t);
  if (!spec) return t;
  return serializeGraphSpec(spec);
}
