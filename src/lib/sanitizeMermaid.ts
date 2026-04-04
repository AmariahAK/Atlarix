/**
 * Conservative fixes for common model-generated Mermaid mistakes before parse/render.
 */
export function sanitizeMermaid(code: string): string {
  if (!code) return code;
  // Capital "Style" is invalid; Mermaid requires lowercase "style".
  return code.replace(/^\s*Style\s/gm, (m) => m.replace("Style", "style"));
}
