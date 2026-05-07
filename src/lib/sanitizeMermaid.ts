import { prepareMermaidForParse } from "@/lib/normalizeDiagramMermaid";

/**
 * Conservative fixes for common model-generated Mermaid mistakes before parse/render.
 * Delegates to prepareMermaidForParse (fences, mermaid prefix, Style, style-line hex scrub).
 */
export function sanitizeMermaid(code: string): string {
  if (!code) return code;
  return prepareMermaidForParse(code);
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
