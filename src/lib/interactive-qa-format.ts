/**
 * Shared Markdown formatting for interactive question answers shown as user bubbles.
 */

export function formatInteractiveQaLine(question: string, answer: string): string {
  const q = String(question ?? "").trim();
  const a = String(answer ?? "").trim();
  return `***Q:*** ${q} → ***A:*** ${a}`;
}

export function formatInteractiveQaBlock(pairs: { question: string; answer: string }[]): string {
  return pairs
    .map(({ question, answer }) => formatInteractiveQaLine(question, answer))
    .join("\n\n");
}
