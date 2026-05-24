/** Merge stable + dynamic system prompt parts for AI SDK `system` (avoids system-role messages). */
export function mergeSystemPromptParts(
  stable: string,
  ...dynamicParts: (string | undefined)[]
): string {
  const parts = [stable, ...dynamicParts].filter(
    (s): s is string => typeof s === "string" && s.trim().length > 0,
  );
  return parts.join("\n\n");
}
