/** Providers that use native function calling — skip text-XML tool fallback unless forced. */
const NATIVE_FC_PROVIDERS = new Set([
  "compass",
  "openrouter",
  "anthropic",
  "openai",
  "google",
  "azure",
  "bedrock",
]);

export function shouldUseTextToolFallback(providerId: string | undefined): boolean {
  if (process.env.ATLARIX_FORCE_TEXT_TOOLS === "1") return true;
  if (process.env.ATLARIX_DISABLE_TEXT_TOOLS === "1") return false;
  if (!providerId) return false;
  return !NATIVE_FC_PROVIDERS.has(providerId);
}
