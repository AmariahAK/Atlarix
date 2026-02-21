/**
 * Provider-native model fetchers
 * ==============================
 * Fetches models directly from each provider's API (when API key is configured).
 * Filters for tool-calling support so Atlarix only shows models that work with
 * native tool calling (commands, file edits, etc.).
 */

import log from "electron-log";
import type { LanguageModel } from "@/ipc/ipc_types";
import { getEnvVar } from "@/ipc/utils/read_env";

const logger = log.scope("provider_fetchers");

const CACHE_MS = 5 * 60 * 1000; // 5 min per-provider cache
const cache = new Map<string, { models: LanguageModel[]; ts: number }>();

function fromCache(providerId: string): LanguageModel[] | null {
  const entry = cache.get(providerId);
  if (!entry || Date.now() - entry.ts > CACHE_MS) return null;
  return entry.models;
}

function toCache(providerId: string, models: LanguageModel[]) {
  cache.set(providerId, { models, ts: Date.now() });
}

function sortModels(models: LanguageModel[]) {
  models.sort((a, b) => {
    const ctxA = a.contextWindow ?? 0;
    const ctxB = b.contextWindow ?? 0;
    if (ctxB !== ctxA) return ctxB - ctxA;
    return (a.displayName ?? "").localeCompare(b.displayName ?? "");
  });
}

/** OpenAI: exclude embeddings, whisper, image gen, tts. Include chat models. */
const OPENAI_EXCLUDE_PREFIXES = [
  "text-embedding-",
  "whisper-",
  "dall-e",
  "tts-",
  "tts_",
  "gpt-4o-audio",
  "gpt-4.1-audio",
];

function isOpenAIChatModel(id: string): boolean {
  if (OPENAI_EXCLUDE_PREFIXES.some((p) => id.startsWith(p))) return false;
  return (
    id.startsWith("gpt-") ||
    id.startsWith("o1-") ||
    id.startsWith("o3-") ||
    id.startsWith("ft:gpt-")
  );
}

/** Groq: exclude embeddings, tts. Include chat/completion models */
const GROQ_EXCLUDE_PREFIXES = ["embed", "whisper", "tts"];

function isGroqChatModel(id: string): boolean {
  const lower = id.toLowerCase();
  if (GROQ_EXCLUDE_PREFIXES.some((p) => lower.includes(p))) return false;
  return true; // Groq's models endpoint is mostly chat models
}

export async function fetchModelsFromOpenAI(
  apiKey: string
): Promise<LanguageModel[]> {
  const cached = fromCache("openai");
  if (cached) return cached;

  try {
    const res = await fetch("https://api.openai.com/v1/models", {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as { data?: { id: string }[] };
    const items = data.data ?? [];
    const models: LanguageModel[] = items
      .filter((m) => isOpenAIChatModel(m.id))
      .map((m) => ({
        apiName: m.id,
        displayName: m.id.replace(/^gpt-/, "GPT-").replace(/^o1-/, "O1-").replace(/^o3-/, "O3-"),
        description: "Chat model with tool support",
        type: "cloud" as const,
        supportsToolChoice: true,
      }));
    sortModels(models);
    toCache("openai", models);
    logger.info(`[OpenAI] Fetched ${models.length} tool-capable models`);
    return models;
  } catch (e) {
    logger.warn("[OpenAI] Fetch failed", e);
    return [];
  }
}

export async function fetchModelsFromAnthropic(
  apiKey: string
): Promise<LanguageModel[]> {
  const cached = fromCache("anthropic");
  if (cached) return cached;

  try {
    const res = await fetch("https://api.anthropic.com/v1/models", {
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as {
      data?: { id: string; display_name?: string }[];
    };
    const items = data.data ?? [];
    const models: LanguageModel[] = items.map((m) => ({
      apiName: m.id,
      displayName: m.display_name ?? m.id,
      description: "Claude model with tool support",
      type: "cloud" as const,
      supportsToolChoice: true,
    }));
    sortModels(models);
    toCache("anthropic", models);
    logger.info(`[Anthropic] Fetched ${models.length} models`);
    return models;
  } catch (e) {
    logger.warn("[Anthropic] Fetch failed", e);
    return [];
  }
}

export async function fetchModelsFromGoogle(
  apiKey: string
): Promise<LanguageModel[]> {
  const cached = fromCache("google");
  if (cached) return cached;

  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`,
      { signal: AbortSignal.timeout(15_000) }
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as {
      models?: {
        name: string;
        displayName?: string;
        supportedGenerationMethods?: string[];
        inputTokenLimit?: number;
        outputTokenLimit?: number;
      }[];
    };
    const items = data.models ?? [];
    const models: LanguageModel[] = items
      .filter(
        (m) =>
          m.supportedGenerationMethods?.includes("generateContent") ||
          m.supportedGenerationMethods?.includes("generateMessage")
      )
      .map((m) => {
        const id = m.name.replace("models/", "");
        return {
          apiName: id,
          displayName: m.displayName ?? id,
          description: "Gemini model with tool support",
          contextWindow: m.inputTokenLimit,
          maxOutputTokens: m.outputTokenLimit,
          type: "cloud" as const,
          supportsToolChoice: true,
        };
      });
    sortModels(models);
    toCache("google", models);
    logger.info(`[Google] Fetched ${models.length} models`);
    return models;
  } catch (e) {
    logger.warn("[Google] Fetch failed", e);
    return [];
  }
}

export async function fetchModelsFromGroq(
  apiKey: string
): Promise<LanguageModel[]> {
  const cached = fromCache("groq");
  if (cached) return cached;

  try {
    const res = await fetch("https://api.groq.com/openai/v1/models", {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as { data?: { id: string }[] };
    const items = data.data ?? [];
    const models: LanguageModel[] = items
      .filter((m) => isGroqChatModel(m.id))
      .map((m) => ({
        apiName: m.id,
        displayName: m.id,
        description: "Chat model with tool support",
        type: "cloud" as const,
        supportsToolChoice: true,
      }));
    sortModels(models);
    toCache("groq", models);
    logger.info(`[Groq] Fetched ${models.length} models`);
    return models;
  } catch (e) {
    logger.warn("[Groq] Fetch failed", e);
    return [];
  }
}

export async function fetchModelsFromTogether(
  apiKey: string
): Promise<LanguageModel[]> {
  const cached = fromCache("together");
  if (cached) return cached;

  try {
    const res = await fetch("https://api.together.xyz/v1/models", {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as {
      data?: { id: string; type?: string; display_name?: string; context_length?: number }[];
    };
    const items = Array.isArray(data) ? data : data.data ?? [];
    const models: LanguageModel[] = items
      .filter((m) => m.type === "chat" || m.type === "code")
      .map((m) => ({
        apiName: m.id,
        displayName: m.display_name ?? m.id,
        description: "Chat/code model with tool support",
        contextWindow: m.context_length,
        type: "cloud" as const,
        supportsToolChoice: true,
      }));
    sortModels(models);
    toCache("together", models);
    logger.info(`[Together] Fetched ${models.length} tool-capable models`);
    return models;
  } catch (e) {
    logger.warn("[Together] Fetch failed", e);
    return [];
  }
}

export async function fetchModelsFromMistral(
  apiKey: string
): Promise<LanguageModel[]> {
  const cached = fromCache("mistral");
  if (cached) return cached;

  try {
    const res = await fetch("https://api.mistral.ai/v1/models", {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as {
      data?: {
        id: string;
        capabilities?: { function_calling?: boolean };
        max_context_length?: number;
      }[];
    };
    const items = data.data ?? [];
    const models: LanguageModel[] = items
      .filter((m) => m.capabilities?.function_calling === true)
      .map((m) => ({
        apiName: m.id,
        displayName: m.id,
        description: "Mistral model with function calling",
        contextWindow: m.max_context_length,
        type: "cloud" as const,
        supportsToolChoice: true,
      }));
    sortModels(models);
    toCache("mistral", models);
    logger.info(`[Mistral] Fetched ${models.length} tool-capable models`);
    return models;
  } catch (e) {
    logger.warn("[Mistral] Fetch failed", e);
    return [];
  }
}

export async function fetchModelsFromXai(
  apiKey: string
): Promise<LanguageModel[]> {
  const cached = fromCache("xai");
  if (cached) return cached;

  try {
    const res = await fetch("https://api.x.ai/v1/models", {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as { data?: { id: string }[] };
    const items = data.data ?? [];
    const models: LanguageModel[] = items.map((m) => ({
      apiName: m.id,
      displayName: m.id.replace(/^grok-/, "Grok "),
      description: "Grok model with tool support",
      type: "cloud" as const,
      supportsToolChoice: true,
    }));
    sortModels(models);
    toCache("xai", models);
    logger.info(`[xAI] Fetched ${models.length} models`);
    return models;
  } catch (e) {
    logger.warn("[xAI] Fetch failed", e);
    return [];
  }
}

/** Elastic Agent Builder: list agents from Kibana. Uses baseUrl from settings or ELASTIC_AGENT_BUILDER_KIBANA_URL. */
export async function fetchModelsFromElastic(
  apiKey: string
): Promise<LanguageModel[]> {
  const cached = fromCache("elastic");
  if (cached) return cached;

  let baseUrl = getEnvVar("ELASTIC_AGENT_BUILDER_KIBANA_URL")?.trim();
  if (!baseUrl && typeof process !== "undefined" && (process as NodeJS.Process).type === "browser") {
    try {
      const { readSettings } = await import("@/main/settings");
      baseUrl = (readSettings()?.providerSettings?.elastic as { baseUrl?: string } | undefined)?.baseUrl?.trim();
    } catch {
      // ignore
    }
  }
  if (!baseUrl) {
    logger.warn("[Elastic] Kibana URL not set in Settings or ELASTIC_AGENT_BUILDER_KIBANA_URL; cannot list agents");
    return [];
  }

  const url = `${baseUrl.replace(/\/$/, "")}/api/agent_builder/agents`;
  try {
    const res = await fetch(url, {
      headers: {
        Authorization: `ApiKey ${apiKey}`,
        "kbn-xsrf": "true",
      },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as {
      data?: Array<{ id: string; name?: string; description?: string }>;
    };
    const items = data.data ?? [];
    const models: LanguageModel[] = items.map((m) => ({
      apiName: m.id,
      displayName: m.name ?? m.id,
      description: m.description ?? "Elastic Agent Builder agent",
      type: "cloud" as const,
      supportsToolChoice: true,
    }));
    sortModels(models);
    toCache("elastic", models);
    logger.info(`[Elastic] Fetched ${models.length} agents`);
    return models;
  } catch (e) {
    logger.warn("[Elastic] Fetch failed", e);
    return [];
  }
}

const FETCHERS: Record<
  string,
  (apiKey: string) => Promise<LanguageModel[]>
> = {
  openai: fetchModelsFromOpenAI,
  anthropic: fetchModelsFromAnthropic,
  google: fetchModelsFromGoogle,
  groq: fetchModelsFromGroq,
  together: fetchModelsFromTogether,
  togetherai: fetchModelsFromTogether,
  mistral: fetchModelsFromMistral,
  xai: fetchModelsFromXai,
  elastic: fetchModelsFromElastic,
};

export async function fetchModelsFromProvider(
  providerId: string,
  apiKey: string
): Promise<LanguageModel[]> {
  const key = providerId === "together" ? "togetherai" : providerId;
  const fetcher = FETCHERS[key];
  if (!fetcher) return [];
  return fetcher(apiKey);
}

export function invalidateProviderModelCache(providerId?: string) {
  if (providerId) {
    cache.delete(providerId);
    if (providerId === "together") cache.delete("togetherai");
    if (providerId === "togetherai") cache.delete("together");
  } else {
    cache.clear();
  }
}

export function supportsProviderNativeFetch(providerId: string): boolean {
  const key = providerId === "together" ? "togetherai" : providerId;
  return key in FETCHERS;
}
