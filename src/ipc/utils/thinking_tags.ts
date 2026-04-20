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
