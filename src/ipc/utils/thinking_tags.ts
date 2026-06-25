export function removeThinkingTags(text: string): string {
  let out = text;
  // Be liberal in what we accept: providers sometimes emit <thinking> or mixed-case tags.
  out = out.replace(/<redacted_thinking>([\s\S]*?)<\/redacted_thinking>/gi, "");
  out = out.replace(/<think>([\s\S]*?)<\/think>/gi, "");
  out = out.replace(/<thinking>([\s\S]*?)<\/thinking>/gi, "");
  // Safety: remove any stray opener/closer that leaked during streaming truncation.
  out = out.replace(/<\/?(?:think|thinking|redacted_thinking)>/gi, "");
  return out.trim();
}

/**
 * Narrow strip targeting only `<think>…</think>` blocks. Used to keep the
 * renderer stream (ThinkingCard) intact while preventing the model from
 * re-ingesting its own reasoning on the next continuation round and
 * polluting the persisted DB row with tokens that don't belong there.
 *
 * Do NOT call this from the renderer stream path — it would kill the live
 * reasoning card. Apply only at:
 *   1. The point where assistant content is appended to agenticMessages /
 *      buildContinuationPrompt for the model's next turn.
 *   2. The point where the assistant message is written to SQLite.
 */
export function stripThinkBlocks(content: string): string {
  return content.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
}

/** Strip internal signals for assistant bubbles and DB rows. */
export function stripAssistantDisplayContent(content: string): string {
  return stripThinkBlocks(content);
}
