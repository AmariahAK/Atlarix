import { prepareMermaidForParse } from "@/lib/normalizeDiagramMermaid";

/**
 * Conservative fixes for common model-generated Mermaid mistakes before parse/render.
 * Delegates to prepareMermaidForParse (fences, mermaid prefix, Style, style-line hex scrub).
 */
export function sanitizeMermaid(code: string): string {
  if (!code) return code;
  return prepareMermaidForParse(code);
}
