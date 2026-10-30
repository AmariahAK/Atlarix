/**
 * Shared OpenRouter / API model id → user-facing label (main + renderer).
 */

export function formatModelApiNameForDisplay(apiName: string): string {
  const raw = (apiName ?? "").trim();
  if (!raw || raw === "auto") return "the configured model";
  const parts = raw.split("/");
  const modelName = (parts[parts.length - 1] || raw)
    // A vendor written as a dotted prefix, with an optional region before it
    // (Bedrock: `us.anthropic.claude-…`, `zai.glm-4.7-flash`): the name is what
    // follows. Only letters/digits before each dot, so `gpt-4.1` is untouched.
    .replace(/^(?:[a-z]{2,6}\.)?[a-z][a-z0-9]*\.(?=[a-z])/i, "")
    // A version stamp is not part of the name: `-v1:0` (Bedrock), `-20251001`
    // (a dated snapshot), in either order.
    .replace(/(?:-v\d+(?::\d+)?|-\d{8})+$/i, "");
  return modelName
    // A version written with dashes reads as one: claude-sonnet-4-6 → 4.6, not "4 6".
    .replace(/(?<=\b\d)-(?=\d\b)/g, ".")
    .replace(/-/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .replace(/Gpt/g, "GPT")
    .replace(/Deepseek/g, "DeepSeek")
    .replace(/Claude/g, "Claude")
    .replace(/Gemini/g, "Gemini")
    .replace(/Qwen/g, "Qwen")
    .replace(/Pony/g, "Pony")
    .replace(/Minimax/g, "MiniMax")
    .replace(/Kimi/g, "Kimi")
    .replace(/\bGlm\b/g, "GLM")
    .trim();
}

export function formatModelWithProvider(
  modelDisplayName: string,
  providerSlug: string,
): string {
  const name = (modelDisplayName ?? "").trim() || "model";
  // An endpoint of your own is stored as `custom::<id>`: show the id, not the prefix.
  const slug = (providerSlug ?? "openrouter").trim().toLowerCase().replace(/^custom::/, "");
  return `${name} (${slug})`;
}
