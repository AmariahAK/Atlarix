/**
 * Derive a workspace session title from the first user message (no AI call).
 */
export function titleFromFirstUserMessage(content: string): string {
  const trimmed = content.trim();
  if (!trimmed) return "Untitled";
  if (trimmed.length <= 50) return trimmed;
  return `${trimmed.slice(0, 50).trimEnd()}…`;
}
