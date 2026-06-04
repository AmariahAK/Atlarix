/**
 * Renderer stub for `lib/context/token-counter` (main-only — the real module
 * pulls `@anthropic-ai/tokenizer` → tiktoken wasm, which the renderer Vite
 * build cannot bundle). The renderer only reaches token counting through
 * code paths guarded by `isMainProcessNode()`, so a chars/4 estimate is a
 * safe placeholder for any stray call.
 */

export function exactTokenCount(
  messages: { role: string; content: string }[],
): number {
  const totalChars = messages.map((m) => m.content).join("").length;
  return Math.ceil(totalChars / 4);
}

export function exactTokenCountText(text: string): number {
  return Math.ceil(text.length / 4);
}
