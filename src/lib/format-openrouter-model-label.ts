/**
 * Shared OpenRouter / API model id → user-facing label (main + renderer).
 */

export function formatModelApiNameForDisplay(apiName: string): string {
  const raw = (apiName ?? "").trim();
  if (!raw || raw === "auto") return "the configured model";
  const parts = raw.split("/");
  const modelName = parts[parts.length - 1] || raw;
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
    .trim();
}

export function formatModelWithProvider(
  modelDisplayName: string,
  providerSlug: string,
): string {
  const name = (modelDisplayName ?? "").trim() || "model";
  const slug = (providerSlug ?? "openrouter").trim().toLowerCase();
  return `${name} (${slug})`;
}
