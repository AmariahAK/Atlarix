/**
 * Does this saved key work? One authenticated GET of the provider's model list.
 *
 * The model fetchers (provider_model_fetchers.ts) can't answer it: they swallow
 * errors, cache, and fall back to the models.dev catalog, so a revoked key still
 * "lists" models. This asks the provider directly and reads only the status.
 * The key never appears in what is returned, only the provider's own message.
 */

export type KeyStatus = "works" | "rejected" | "unchecked" | "unreachable";

export interface KeyCheck {
  status: KeyStatus;
  detail: string;
}

export interface KeyProbe {
  url: string;
  headers: Record<string, string>;
}

/**
 * Providers on their own SDK whose catalog row carries no base URL. Every other
 * provider is OpenAI-compatible at its resolved base URL.
 */
const NATIVE_MODELS_URL: Record<string, string> = {
  openai: "https://api.openai.com/v1/models",
  openrouter: "https://openrouter.ai/api/v1/models",
  xai: "https://api.x.ai/v1/models",
};

/** Signed in through a cloud account rather than one key: nothing to probe. */
const ACCOUNT_AUTH = new Set(["vertex", "bedrock", "azure", "amazon-bedrock", "google-vertex"]);

/** The request that proves a key, or null when this provider can't be checked this way. */
export function keyProbe(providerId: string, apiKey: string, baseUrl?: string | null): KeyProbe | null {
  if (ACCOUNT_AUTH.has(providerId)) return null;
  if (providerId === "anthropic") {
    return { url: "https://api.anthropic.com/v1/models", headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01" } };
  }
  if (providerId === "google" || providerId === "gemini") {
    return { url: "https://generativelanguage.googleapis.com/v1beta/models", headers: { "x-goog-api-key": apiKey } };
  }
  const url = NATIVE_MODELS_URL[providerId] ?? (baseUrl ? `${baseUrl.replace(/\/+$/, "")}/models` : null);
  return url ? { url, headers: { Authorization: `Bearer ${apiKey}` } } : null;
}

const KEY_WORDS = /api.?key|invalid.*(key|token)|unauthori[sz]ed|authenticat|forbidden|permission|credential/i;

/** The provider's own words, without anything that could be the key. */
function providerMessage(body: string, apiKey: string): string {
  let msg = body;
  try {
    const j = JSON.parse(body) as { error?: { message?: string } | string; message?: string; detail?: string };
    msg = (typeof j.error === "string" ? j.error : j.error?.message) ?? j.message ?? j.detail ?? body;
  } catch {
    /* plain text */
  }
  if (apiKey.length >= 8) msg = msg.split(apiKey).join("…");
  return msg.replace(/\s+/g, " ").trim().slice(0, 160);
}

export async function checkProviderKey(
  probe: KeyProbe | null,
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
): Promise<KeyCheck> {
  if (!probe) return { status: "unchecked", detail: "This provider can't be checked from here. Saved keys still work in chats." };
  let res: Response;
  try {
    res = await fetchImpl(probe.url, { headers: probe.headers, signal: AbortSignal.timeout(15_000) });
  } catch (e) {
    return { status: "unreachable", detail: `Couldn't reach the provider: ${(e as Error).message ?? String(e)}` };
  }
  const body = await res.text().catch(() => "");
  if (res.ok) {
    let count: number | null = null;
    try {
      const j = JSON.parse(body) as { data?: unknown[]; models?: unknown[] };
      const list = j.data ?? j.models;
      if (Array.isArray(list)) count = list.length;
    } catch {
      /* not JSON; still a yes */
    }
    return { status: "works", detail: count != null ? `${count} models` : "OK" };
  }
  const msg = providerMessage(body, apiKey);
  // Google says 400 for a bad key; most say 401 or 403.
  if (res.status === 401 || res.status === 403 || (res.status === 400 && KEY_WORDS.test(msg))) {
    return { status: "rejected", detail: msg || `HTTP ${res.status}` };
  }
  if (res.status === 404 || res.status === 405) {
    return { status: "unchecked", detail: "This provider doesn't list its models, so the key can't be checked here." };
  }
  return { status: "unreachable", detail: msg ? `HTTP ${res.status}: ${msg}` : `HTTP ${res.status}` };
}

/** "sk-…a91f": enough to tell keys apart, never enough to use one. */
export function keyHint(key: string | null | undefined): string | undefined {
  const k = (key ?? "").trim();
  if (!k) return undefined;
  if (k.length <= 12) return "••••";
  const dash = k.indexOf("-");
  const prefix = dash > 0 && dash <= 6 ? k.slice(0, dash + 1) : k.slice(0, 3);
  return `${prefix}…${k.slice(-4)}`;
}
