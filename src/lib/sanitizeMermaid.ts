import { prepareMermaidForParse } from "@/lib/normalizeDiagramMermaid";

/**
 * Conservative fixes for common model-generated Mermaid mistakes before parse/render.
 * Delegates to prepareMermaidForParse (fences, mermaid prefix, Style, style-line hex scrub).
 */
export function sanitizeMermaid(code: string): string {
  if (!code) return code;
  let s = prepareMermaidForParse(code);
  s = mergeBrokenSequenceMessageLines(s);
  s = repairSequenceDiagramMessages(s);
  if (/^\s*(flowchart|graph)\b/im.test(s.trim())) {
    s = repairBracketMermaidLabels(s);
  }
  return s;
}

/** Mindmaps need a non-paren root line; streamed fragments like `("Python/JAX")` fail parse. */
export function isIncompleteMindmapSource(code: string): boolean {
  const t = code.trim();
  if (!/^mindmap\b/im.test(t)) return false;
  const lines = t
    .split("\n")
    .slice(1)
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length === 0) return true;
  const hasRoot = lines.some((l) => !/^\(\s*.+\)\s*$/.test(l));
  return !hasRoot;
}

const SEQUENCE_DIRECTIVE_RE =
  /^\s*(sequenceDiagram|participant|actor|loop|alt|else|end|note|rect|critical|break|par|and|opt|autonumber|activate|deactivate|title|link|links)\b/i;

const SEQUENCE_ARROW_RE =
  /^(\s*[^\s:]+(?:\[[^\]]*\])?\s*(?:->>|-->>|->|--x|-x|--\)|--\))\s*[^\s:]+(?:\[[^\]]*\])?\s*:\s*)(.*)$/;

/** Join message text split across lines (common in streamed model output). */
export function mergeBrokenSequenceMessageLines(code: string): string {
  if (!/^sequenceDiagram\b/im.test(code.trim())) return code;
  const lines = code.split("\n");
  const out: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (out.length > 0 && trimmed) {
      const prev = out[out.length - 1]!;
      const prevHasMessage =
        SEQUENCE_ARROW_RE.test(prev) ||
        (/-->|->>|-->>|->/.test(prev) && prev.includes(":"));
      const isContinuation =
        !SEQUENCE_DIRECTIVE_RE.test(trimmed) &&
        !SEQUENCE_ARROW_RE.test(line) &&
        !/^\s*[^\s:]+(?:\[[^\]]*\])?\s*(?:->>|-->>|->)/.test(trimmed);
      if (prevHasMessage && isContinuation) {
        out[out.length - 1] = `${prev.trimEnd()} ${trimmed}`;
        continue;
      }
    }
    out.push(line);
  }
  return out.join("\n");
}

/**
 * Quote or clean sequence message labels that break the parser (`{}`, pipes, etc.).
 */
export function repairSequenceDiagramMessages(code: string): string {
  if (!/^sequenceDiagram\b/im.test(code.trim())) return code;
  return code
    .split("\n")
    .map((line) => {
      const m = line.match(SEQUENCE_ARROW_RE);
      if (!m) return line;
      const prefix = m[1]!;
      let msg = m[2]!.trimEnd();
      if (!msg) return line;
      if (
        (msg.startsWith('"') && msg.endsWith('"')) ||
        (msg.startsWith("'") && msg.endsWith("'"))
      ) {
        return line;
      }
      if (/[{}|<>]/.test(msg) || (msg.includes("(") && !msg.includes(")"))) {
        const cleaned = msg
          .replace(/"/g, "'")
          .replace(/[{}|<>]/g, "")
          .replace(/\s+/g, " ")
          .trim();
        return `${prefix}"${cleaned}"`;
      }
      return line;
    })
    .join("\n");
}

/**
 * Second-pass repair when parse fails: fix unquoted `[Label (detail)]` style labels
 * by rewriting parentheses to " - detail" and stripping disallowed chars inside brackets.
 */
export function repairBracketMermaidLabels(code: string): string {
  if (!code) return code;
  return code.replace(/\[([^[\]]+)\]/g, (_full, inner: string) => {
    if (!/[()]/.test(inner) && !/[{}|<>]/.test(inner)) return `[${inner}]`;
    let out = inner.replace(/\(([^)]*)\)/g, " - $1");
    out = out.replace(/[{}|<>]/g, "");
    out = out.replace(/\s{2,}/g, " ").trim();
    return `[${out}]`;
  });
}
