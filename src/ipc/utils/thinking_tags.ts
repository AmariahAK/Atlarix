export function removeThinkingTags(text: string): string {
  let out = text;
  out = out.replace(/<redacted_thinking>([\s\S]*?)<\/redacted_thinking>/g, "");
  out = out.replace(/<think>([\s\S]*?)<\/think>/g, "");
  return out.trim();
}
