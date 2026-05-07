/**
 * Sent on all OpenRouter HTTP and SDK requests so OpenRouter usage logs show "Atlarix"
 * instead of "Unknown". See https://openrouter.ai/docs
 */
export const OPENROUTER_APP_HEADERS: Record<string, string> = {
  "X-Title": "Atlarix",
  "HTTP-Referer": "https://atlarix.dev",
};
