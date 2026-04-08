/**
 * Normalize AI-produced and stored Mermaid so parse/render matches Mermaid's expectations.
 * Fixes: leading "mermaid" language line, loose ``` fences, capital Style, corrupted hex in style lines.
 */

const ZERO_WIDTH_RE = /[\u200B-\u200D\uFEFF]/g;

/** Extract inner body from a markdown ```mermaid / ``` fence if present (handles \r\n, optional language on first line). */
export function stripMermaidCodeFence(raw: string): string {
  let s = raw.replace(/^\uFEFF/, "").trim();
  if (!s.startsWith("```")) return s;
  const firstNl = s.indexOf("\n");
  if (firstNl === -1) return s;
  const body = s.slice(firstNl + 1);
  const close = body.lastIndexOf("```");
  if (close === -1) return s.trim();
  return body.slice(0, close).trim();
}

/**
 * If the model returned prose + diagram without fences, keep from the first diagram directive line.
 */
export function sliceFromFirstDiagramLine(text: string): string {
  const lines = text.split(/\r?\n/);
  const idx = lines.findIndex((l) => {
    const t = l.trim();
    if (!t) return false;
    if (/^\s*mermaid\s+(graph|flowchart|sequenceDiagram|classDiagram|stateDiagram|erDiagram|journey|gantt)\b/i.test(t)) {
      return true;
    }
    return /^(graph\s|flowchart\s|sequenceDiagram|classDiagram|stateDiagram|erDiagram|journey|gantt\b)/i.test(t);
  });
  if (idx < 0) return text.trim();
  let slice = lines.slice(idx).join("\n");
  slice = slice.replace(/^\s*mermaid\s+(?=(?:graph|flowchart|sequenceDiagram|classDiagram|stateDiagram|erDiagram|journey|gantt)\b)/i, "");
  return slice.trim();
}

/** Remove a standalone first line that is only "mermaid" (markdown copy-paste artifact). */
export function stripStandaloneMermaidLanguageLine(s: string): string {
  const lines = s.split(/\r?\n/);
  while (lines.length && !lines[0].trim()) lines.shift();
  if (lines.length && /^mermaid\s*$/i.test(lines[0].trim())) {
    lines.shift();
    return lines.join("\n").trim();
  }
  return s.trim();
}

/** Collapse junk characters inside #hex tokens on style/linkStyle/classDef lines (model / font corruption). */
export function scrubHexInStyleLines(line: string): string {
  const isStyleLine = /^\s*(linkStyle|style|classDef)\b/i.test(line);
  if (!isStyleLine) return line;
  return line.replace(/#([^\s;,)]+)/g, (_full, hexPart: string) => {
    const clean = hexPart.replace(/[^0-9a-fA-F]/g, "").slice(0, 8);
    if (!clean) return "#333333";
    return `#${clean}`;
  });
}

function sanitizeMermaidIdentifier(raw: string): string {
  const s = String(raw ?? "").trim();
  if (!s) return "id";
  // Mermaid IDs are safest as [A-Za-z0-9_]. Preserve existing underscores.
  let out = s.replace(/[^A-Za-z0-9_]/g, "_");
  out = out.replace(/_+/g, "_").replace(/^_+/, "").replace(/_+$/, "");
  return out || "id";
}

/** Fix invalid IDs in style/classDef lines (models sometimes use labels like `Auth & Services`). */
export function scrubDirectiveIdentifiers(line: string): string {
  const m = line.match(/^\s*(style|classDef)\s+(.+?)\s+(.+)$/i);
  if (!m) return line;
  const directive = m[1];
  const rest = m[2] + " " + m[3];
  const tokens = rest.trim().split(/\s+/);
  // Find the first token that looks like a property boundary (contains ':' or is like 'fill:' 'stroke:' etc).
  const propIdx = tokens.findIndex((t) => t.includes(":") || t.includes(","));
  if (propIdx <= 0) return line;
  const idTokens = tokens.slice(0, propIdx);
  const propTokens = tokens.slice(propIdx);
  const safeId = sanitizeMermaidIdentifier(idTokens.join("_"));
  return line.replace(/^\s*(style|classDef)\s+(.+?)\s+(.+)$/i, (_full, d) => `${d} ${safeId} ${propTokens.join(" ")}`);
}

/**
 * Full normalization before mermaid.parse / mermaid.render (DB content or post-AI extract).
 */
export function prepareMermaidForParse(code: string): string {
  if (!code) return code;
  let s = code.replace(/^\uFEFF/, "").trim();
  s = stripMermaidCodeFence(s);
  s = stripStandaloneMermaidLanguageLine(s);
  s = s.replace(/^\s*mermaid\s+(?=(?:graph|flowchart|sequenceDiagram|classDiagram|stateDiagram|erDiagram|journey|gantt)\b)/im, "");
  s = s.trim();
  try {
    s = s.normalize("NFKC");
  } catch {
    /* ignore */
  }
  s = s.replace(ZERO_WIDTH_RE, "");
  s = s.replace(/^\s*Style\s/gm, (m) => m.replace("Style", "style"));
  s = s
    .split(/\r?\n/)
    .map((line) => scrubDirectiveIdentifiers(scrubHexInStyleLines(line)))
    .join("\n");
  return s.trim();
}

const FENCE_MERMAID = /```mermaid\s*\r?\n([\s\S]*?)```/i;
const FENCE_GENERIC = /```(?:mermaid)?\s*\r?\n([\s\S]*?)```/i;

/**
 * Normalize raw model output into storable / parseable Mermaid body.
 */
export function normalizeDiagramAiOutput(rawText: string): string {
  if (!rawText) return rawText;
  let t = rawText.replace(/^\uFEFF/, "").trim();
  let m = t.match(FENCE_MERMAID);
  if (m) {
    t = m[1].trim();
  } else {
    m = t.match(FENCE_GENERIC);
    if (m) {
      t = m[1].trim();
    } else {
      t = sliceFromFirstDiagramLine(t);
    }
  }
  return prepareMermaidForParse(t);
}
