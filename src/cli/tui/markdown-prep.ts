/**
 * Markdown as the agent writes it, made to read well in a terminal before the
 * `<markdown>` renderer sees it. Pure (src/__tests__/cli-markdown-prep.test.ts).
 *
 * - The app draws ```chart / ```graph / ```markmap fences as cards (AGENTS.md
 *   "Visual artifacts"). A terminal can't, and their raw JSON is noise, so each
 *   becomes what it says: a chart as labelled bars, a graph as its edges, a
 *   markmap as the outline it already is.
 * - GFM keeps a table going until a blank line, so prose written straight
 *   after one turned into extra table rows. A blank line closes the table.
 * - `---` straight under text is a heading in markdown; here it is the
 *   separator the model meant.
 */

const BAR_WIDTH = 24;

function chartText(json: string): string | null {
  try {
    const c = JSON.parse(json) as { title?: string; labels?: unknown[]; values?: unknown[] };
    const labels = (c.labels ?? []).map(String);
    const values = (c.values ?? []).map(Number);
    if (!labels.length || labels.length !== values.length || values.some((v) => !Number.isFinite(v))) return null;
    const max = Math.max(...values.map(Math.abs), 1);
    const pad = Math.max(...labels.map((l) => l.length));
    const rows = labels.map((l, i) => {
      const n = Math.round((Math.abs(values[i]!) / max) * BAR_WIDTH);
      return `${l.padEnd(pad)}  ${"█".repeat(n) || "▏"} ${values[i]}`;
    });
    return [c.title ? `**${c.title}**` : "", "```", ...rows, "```"].filter(Boolean).join("\n");
  } catch {
    return null;
  }
}

function graphText(json: string): string | null {
  try {
    const g = JSON.parse(json) as {
      title?: string;
      nodes?: Array<{ id?: string; name?: string }>;
      edges?: Array<{ source?: string; target?: string; label?: string }>;
    };
    const nodes = g.nodes ?? [];
    if (!nodes.length) return null;
    const name = new Map(nodes.map((n) => [String(n.id), String(n.name ?? n.id)]));
    const edges = (g.edges ?? []).map(
      (e) => `- ${name.get(String(e.source)) ?? e.source} → ${name.get(String(e.target)) ?? e.target}${e.label ? ` (${e.label})` : ""}`,
    );
    const linked = new Set((g.edges ?? []).flatMap((e) => [String(e.source), String(e.target)]));
    const alone = nodes.filter((n) => !linked.has(String(n.id))).map((n) => `- ${name.get(String(n.id))}`);
    return [g.title ? `**${g.title}**` : "", ...edges, ...alone].filter(Boolean).join("\n");
  } catch {
    return null;
  }
}

/** A markmap is markdown headings + bullets: headings become nested bullets. */
function markmapText(body: string): string {
  return body
    .split("\n")
    .map((line) => {
      const h = /^(#{1,6})\s+(.*)$/.exec(line);
      if (!h) return line;
      const depth = h[1]!.length - 1;
      return depth === 0 ? `**${h[2]}**` : `${"  ".repeat(depth - 1)}- ${h[2]}`;
    })
    .join("\n");
}

const FENCE = /```(chart|graph|markmap)[^\n]*\n([\s\S]*?)```/g;

/** Close a table before prose that follows it without a blank line. */
function closeTables(text: string): string {
  const lines = text.split("\n");
  const out: string[] = [];
  let inTable = false;
  let inFence = false;
  for (const line of lines) {
    if (/^\s*```/.test(line)) inFence = !inFence;
    const isRow = !inFence && /^\s*\|.*\|\s*$/.test(line);
    if (inTable && !isRow && line.trim() !== "") out.push("");
    inTable = isRow;
    out.push(line);
  }
  return out.join("\n");
}

/**
 * `---` (or `===`) straight under a line of text makes that text a heading
 * (a "setext" heading), and models write `---` meaning a separator, so whole
 * paragraphs came out as headings. A blank line before it keeps it a separator.
 */
function separatorsNotHeadings(text: string): string {
  const lines = text.split("\n");
  const out: string[] = [];
  let inFence = false;
  lines.forEach((line, i) => {
    if (/^\s*```/.test(line)) inFence = !inFence;
    const prev = lines[i - 1];
    if (!inFence && /^\s{0,3}(-{3,}|={3,})\s*$/.test(line) && prev != null && prev.trim() !== "" && !/^\s*\|/.test(prev)) {
      out.push("");
    }
    out.push(line);
  });
  return out.join("\n");
}

export function prepareMarkdown(text: string): string {
  const replaced = text.replace(FENCE, (whole, kind: string, body: string) => {
    const t = kind === "chart" ? chartText(body) : kind === "graph" ? graphText(body) : markmapText(body.trim());
    return t ?? whole;
  });
  return closeTables(separatorsNotHeadings(replaced));
}
