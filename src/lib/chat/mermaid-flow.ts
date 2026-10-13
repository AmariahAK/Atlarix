/**
 * A mermaid flowchart as nodes and edges, so a terminal can say it as its edges
 * and the editor panel can draw it like a ```graph fence.
 *
 * Models answer "draw me a diagram" in mermaid far more often than in our own
 * ```graph JSON, and the raw source (`flowchart TD`, `A --> B[...]`) is noise in
 * a transcript (QA, 2026-10-12). Only flowcharts (`flowchart` / `graph`) are
 * read; any other mermaid diagram returns null and stays a code block.
 *
 * Pure, and deliberately small: node shapes ([], (), (()), {}, [()], >], [//]),
 * quoted labels, arrows (-->, ---, ==>, -.->, --o, --x, <-->), edge labels
 * (`-->|text|` and `-- text -->`), chains (A --> B --> C) and `&` groups. Style,
 * class, click, subgraph and comment lines are skipped.
 */

export type FlowGraph = {
  nodes: Array<{ id: string; name: string }>;
  edges: Array<{ source: string; target: string; label?: string }>;
};

const NODE = /^([A-Za-z0-9_][\w.-]*)\s*(\(\(.*?\)\)|\[\(.*?\)\]|\[\/.*?\/\]|\[\\.*?\\\]|\[.*?\]|\(.*?\)|\{.*?\}|>.*?\])?/;
const ARROW = /^\s*(<?(?:-{2,}|={2,}|-\.+-)[->ox]?)\s*(?:\|([^|]*)\|)?\s*/;
const TEXT_ARROW = /^\s*(?:--|==)\s+([^-=>][^>]*?)\s+(?:-{2,}|={2,})>\s*/;

function unshape(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const inner = raw.replace(/^(\(\(|\[\(|\[\/|\[\\|\[|\(|\{|>)/, "").replace(/(\)\)|\)\]|\/\]|\\\]|\]|\)|\})$/, "");
  const t = inner.trim().replace(/^"(.*)"$/, "$1");
  return t || undefined;
}

export function mermaidFlowchart(code: string): FlowGraph | null {
  const lines = code.split("\n").map((l) => l.replace(/%%.*$/, "").trim()).filter(Boolean);
  if (!lines.length || !/^(flowchart|graph)\b/i.test(lines[0]!)) return null;
  const names = new Map<string, string>();
  const order: string[] = [];
  const edges: FlowGraph["edges"] = [];
  const node = (id: string, label?: string) => {
    if (!names.has(id)) order.push(id);
    if (label || !names.has(id)) names.set(id, label ?? names.get(id) ?? id);
  };
  /** One side of an edge: `A[x]` or `A & B[y]`. Returns the ids and the rest. */
  const side = (s: string): { ids: string[]; rest: string } | null => {
    const ids: string[] = [];
    let rest = s;
    for (;;) {
      const m = NODE.exec(rest);
      if (!m) return ids.length ? { ids, rest } : null;
      node(m[1]!, unshape(m[2]));
      ids.push(m[1]!);
      rest = rest.slice(m[0].length);
      const amp = /^\s*&\s*/.exec(rest);
      if (!amp) return { ids, rest };
      rest = rest.slice(amp[0].length);
    }
  };
  for (const line of lines.slice(1)) {
    if (/^(style|classDef|class|click|linkStyle|subgraph|end|direction)\b/.test(line)) continue;
    let left = side(line);
    if (!left) continue;
    let rest = left.rest;
    while (rest.trim()) {
      let label: string | undefined;
      const t = TEXT_ARROW.exec(rest);
      const a = t ? null : ARROW.exec(rest);
      if (t) {
        label = t[1]!.trim();
        rest = rest.slice(t[0].length);
      } else if (a) {
        label = a[2]?.trim() || undefined;
        rest = rest.slice(a[0].length);
      } else break;
      const right = side(rest);
      if (!right) break;
      for (const s of left.ids) for (const d of right.ids) edges.push({ source: s, target: d, ...(label ? { label } : {}) });
      left = right;
      rest = right.rest;
    }
  }
  if (!order.length) return null;
  return { nodes: order.map((id) => ({ id, name: names.get(id) ?? id })), edges };
}
