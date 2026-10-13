/**
 * The visual fences Atlarix answers with, drawn in the panel as the app draws
 * them (src/components/chat/CodeHighlight.tsx): `graph` as a diagram, `chart`
 * as bars or a line, `markmap` as an outline. Formats are the ones the agent is
 * told to write (AGENTS.md):
 *
 *   graph   { "title"?, "nodes": [{ "id", "name" }], "edges": [{ "source", "target" }] }
 *   chart   { "type": "bar"|"line", "title", "labels": string[], "values": number[] }
 *   markmap markdown headings and bullets under one `#` title
 *
 * While a fence is still streaming, or its JSON is not valid, the code shows as
 * usual: a half-drawn diagram would jump around and then snap into place.
 * Model text never goes through innerHTML: every label is a text node.
 */
import { mermaidFlowchart } from "../../../../src/lib/chat/mermaid-flow";
import { renderMarkdown, type FenceRenderer } from "../../../extension/src/panel/markdown";
import { post } from "../rpc";
import { button, el } from "../ui";

const SVG = "http://www.w3.org/2000/svg";

function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>, text?: string): SVGElementTagNameMap[K] {
  const e = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  if (text != null) e.textContent = text;
  return e;
}

function card(kind: string, label: string, code: string, body: Node): HTMLElement {
  const c = el("figure", `fig fig--${kind}`);
  const head = el("figcaption", "fig__head");
  head.append(el("span", "fig__label", label), button("Copy", "link small", () => post({ type: "copy", text: code })));
  c.append(head, body);
  return c;
}

function parse(code: string): unknown {
  try {
    return JSON.parse(code);
  } catch {
    return null;
  }
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** A layered drawing: each node one row below the deepest node pointing at it. */
let graphs = 0;

function drawGraph(g: { title?: string; nodes: Array<{ id: string; name?: string }>; edges: Array<{ source: string; target: string }> }): SVGSVGElement | null {
  const ids = new Set(g.nodes.map((n) => n.id));
  const edges = g.edges.filter((e) => ids.has(e.source) && ids.has(e.target) && e.source !== e.target);
  const level = new Map<string, number>(g.nodes.map((n) => [n.id, 0]));
  // Longest path from a root, capped so a cycle cannot loop forever.
  for (let pass = 0; pass < g.nodes.length; pass++) {
    let moved = false;
    for (const e of edges) {
      const next = (level.get(e.source) ?? 0) + 1;
      if (next > (level.get(e.target) ?? 0) && next < g.nodes.length) {
        level.set(e.target, next);
        moved = true;
      }
    }
    if (!moved) break;
  }
  const rows: string[][] = [];
  for (const n of g.nodes) (rows[level.get(n.id) ?? 0] ??= []).push(n.id);
  const W = 360, NODE_H = 22, ROW = 48, PAD = 8;
  const pos = new Map<string, { x: number; y: number; w: number }>();
  rows.forEach((row, r) => {
    const w = Math.min(96, (W - PAD * 2) / row.length - 8);
    row.forEach((id, i) => {
      const cx = PAD + ((W - PAD * 2) / row.length) * (i + 0.5);
      pos.set(id, { x: cx - w / 2, y: PAD + r * ROW, w });
    });
  });
  const H = PAD * 2 + (rows.length - 1) * ROW + NODE_H;
  const s = svg("svg", { viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": g.title ?? "Diagram" });
  // Each edge ends in an arrowhead: which way an import goes is the point (QA E8).
  const arrow = `fig-arrow-${++graphs}`;
  const defs = svg("defs", {});
  const marker = svg("marker", { id: arrow, viewBox: "0 0 6 6", refX: 5.5, refY: 3, markerWidth: 6, markerHeight: 6, orient: "auto-start-reverse" });
  marker.append(svg("path", { d: "M0,0 L6,3 L0,6 z", class: "fig__arrow" }));
  defs.append(marker);
  s.append(defs);
  for (const e of edges) {
    const a = pos.get(e.source)!, b = pos.get(e.target)!;
    // Downward edges meet the target's top; one going back up (a cycle) meets its bottom.
    const up = b.y < a.y + NODE_H;
    const x1 = a.x + a.w / 2, y1 = up ? a.y : a.y + NODE_H;
    const x2 = b.x + b.w / 2, y2 = up ? b.y + NODE_H : b.y;
    // An edge that skips a row bends out to the side, not through the nodes between.
    const skips = Math.abs((level.get(e.target) ?? 0) - (level.get(e.source) ?? 0)) > 1;
    const bend = skips ? Math.max(a.w, b.w) / 2 + 26 : 0;
    s.append(
      svg("path", {
        d: skips ? `M${x1},${y1} C${x1 + bend},${y1 + ROW / 2} ${x2 + bend},${y2 - ROW / 2} ${x2},${y2}` : `M${x1},${y1} L${x2},${y2}`,
        class: "fig__edge",
        fill: "none",
        "marker-end": `url(#${arrow})`,
      }),
    );
  }
  const name = new Map(g.nodes.map((n) => [n.id, n.name ?? n.id]));
  for (const [id, p] of pos) {
    s.append(svg("rect", { x: p.x, y: p.y, width: p.w, height: NODE_H, rx: 5, class: (level.get(id) ?? 0) === 0 ? "fig__node root" : "fig__node" }));
    s.append(svg("text", { x: p.x + p.w / 2, y: p.y + NODE_H / 2 + 3.5, class: "fig__text" }, clip(name.get(id) ?? id, Math.max(4, Math.floor(p.w / 6)))));
  }
  return s;
}

function drawChart(c: { type?: string; labels: string[]; values: number[] }): SVGSVGElement | null {
  const n = Math.min(c.labels.length, c.values.length);
  if (!n) return null;
  const W = 360, H = 150, L = 8, B = 22, T = 8;
  const max = Math.max(...c.values.slice(0, n), 0) || 1;
  const step = (W - L * 2) / n;
  const y = (v: number) => T + (H - T - B) * (1 - Math.max(0, v) / max);
  const s = svg("svg", { viewBox: `0 0 ${W} ${H}`, role: "img" });
  s.append(svg("line", { x1: L, y1: H - B, x2: W - L, y2: H - B, class: "fig__axis" }));
  if (c.type === "line") {
    const pts = c.values.slice(0, n).map((v, i) => `${L + step * (i + 0.5)},${y(v)}`).join(" ");
    s.append(svg("polyline", { points: pts, class: "fig__line" }));
    c.values.slice(0, n).forEach((v, i) => s.append(svg("circle", { cx: L + step * (i + 0.5), cy: y(v), r: 2.5, class: "fig__dot" })));
  } else {
    c.values.slice(0, n).forEach((v, i) => {
      const top = y(v);
      s.append(svg("rect", { x: L + step * i + step * 0.15, y: top, width: step * 0.7, height: H - B - top, rx: 2, class: "fig__bar" }));
    });
  }
  c.labels.slice(0, n).forEach((l, i) => {
    s.append(svg("text", { x: L + step * (i + 0.5), y: H - 7, class: "fig__tick" }, clip(String(l), Math.max(3, Math.floor(step / 6)))));
  });
  return s;
}

export const drawFence: FenceRenderer = (lang, code, closed) => {
  if (!closed) return null;
  if (lang === "graph") {
    const g = parse(code) as { title?: string; nodes?: unknown; edges?: unknown } | null;
    if (!g || !Array.isArray(g.nodes) || !Array.isArray(g.edges) || !g.nodes.length) return null;
    const nodes = (g.nodes as Array<{ id?: unknown; name?: unknown }>)
      .filter((n) => n && (typeof n.id === "string" || typeof n.id === "number"))
      .map((n) => ({ id: String(n.id), name: typeof n.name === "string" ? n.name : undefined }));
    const edges = (g.edges as Array<{ source?: unknown; target?: unknown }>)
      .filter((e) => e && e.source != null && e.target != null)
      .map((e) => ({ source: String(e.source), target: String(e.target) }));
    const drawing = drawGraph({ title: g.title, nodes, edges });
    return drawing ? card("graph", g.title?.trim() || `Diagram · ${nodes.length} nodes`, code, drawing) : null;
  }
  if (lang === "chart" || lang === "json-chart") {
    const c = parse(code) as { type?: string; title?: string; labels?: unknown; values?: unknown } | null;
    if (!c || !Array.isArray(c.labels) || !Array.isArray(c.values) || !c.values.every((v) => typeof v === "number")) return null;
    const drawing = drawChart({ type: c.type, labels: c.labels.map(String), values: c.values as number[] });
    return drawing ? card("chart", c.title?.trim() || "Chart", code, drawing) : null;
  }
  if (lang === "mermaid") {
    // A flowchart is drawn like a graph; any other mermaid stays code.
    const g = mermaidFlowchart(code);
    const drawing = g && drawGraph(g);
    return drawing ? card("graph", `Diagram · ${g.nodes.length} nodes`, code, drawing) : null;
  }
  if (lang === "markmap") {
    const body = el("div", "fig__outline");
    renderMarkdown(body, code);
    const title = /^#\s+(.+)$/m.exec(code)?.[1]?.trim();
    return card("markmap", title || "Outline", code, body);
  }
  return null;
};
