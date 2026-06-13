/**
 * Provider-native model fetchers
 * ==============================
 * Fetches models directly from each provider's API (when API key is configured).
 * Filters for tool-calling support so Atlarix only shows models that work with
 * native tool calling (commands, file edits, etc.).
 */

import log from "electron-log";
import type { LanguageModel } from "@/ipc/ipc_types";
import { OPENROUTER_APP_HEADERS } from "@/ipc/shared/openrouter_app_headers";
import { OPENWEIGHT_PROVIDER_BASE_URLS } from "@/ipc/shared/language_model_constants";

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

async function fetchOpenAICompatibleModels(params: {
  providerId: string;
  url: string;
  apiKey: string;
}): Promise<LanguageModel[]> {
  const cached = fromCache(params.providerId);
  if (cached) return cached;

  try {
    const res = await fetch(params.url, {
      headers: { Authorization: `Bearer ${params.apiKey}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as { data?: { id: string }[] };
    const items = data.data ?? [];
    const models: LanguageModel[] = items.map((m) => ({
      apiName: m.id,
      displayName: m.id,
      description: "Chat model with tool support",
      type: "cloud" as const,
      supportsToolChoice: true,
    }));
    sortModels(models);
    toCache(params.providerId, models);
    logger.info(`[${params.providerId}] Fetched ${models.length} models`);
    return models;
  } catch (e) {
    logger.warn(`[${params.providerId}] Fetch failed`, e);
    return [];
  }
}

export async function fetchModelsFromNvidiaNim(
  apiKey: string
): Promise<LanguageModel[]> {
  return fetchOpenAICompatibleModels({
    providerId: "nvidia_nim",
    url: "https://integrate.api.nvidia.com/v1/models",
    apiKey,
  });
}

export async function fetchModelsFromHuggingFace(
  apiKey: string
): Promise<LanguageModel[]> {
  return fetchOpenAICompatibleModels({
    providerId: "huggingface",
    url: "https://router.huggingface.co/v1/models",
    apiKey,
  });
}

export async function fetchModelsFromPerplexity(
  apiKey: string
): Promise<LanguageModel[]> {
  const cached = fromCache("perplexity");
  if (cached) return cached;

  // Perplexity's Sonar API documents these model IDs directly.
  // The generic GET /v1/models endpoint lists Agent API models (including non-Sonar),
  // so we present the Sonar family as the selectable list for this provider.
  //
  // Source: https://docs.perplexity.ai/docs/sonar/models
  void apiKey; // Key presence is required by the caller; unused here.
  const models: LanguageModel[] = [
    {
      apiName: "sonar",
      displayName: "Sonar",
      description: "Fast grounded answers with web search",
      type: "cloud" as const,
      supportsToolChoice: true,
    },
    {
      apiName: "sonar-pro",
      displayName: "Sonar Pro",
      description: "Higher quality grounded answers with web search",
      type: "cloud" as const,
      supportsToolChoice: true,
    },
    {
      apiName: "sonar-reasoning-pro",
      displayName: "Sonar Reasoning Pro",
      description: "Reasoning-focused grounded answers with web search",
      type: "cloud" as const,
      supportsToolChoice: true,
    },
    {
      apiName: "sonar-deep-research",
      displayName: "Sonar Deep Research",
      description: "Deep research answers with web search",
      type: "cloud" as const,
      supportsToolChoice: true,
    },
  ];

  toCache("perplexity", models);
  return models;
}

export async function fetchModelsFromCerebras(
  apiKey: string
): Promise<LanguageModel[]> {
  return fetchOpenAICompatibleModels({
    providerId: "cerebras",
    url: "https://api.cerebras.ai/v1/models",
    apiKey,
  });
}

export async function fetchModelsFromCohere(
  apiKey: string
): Promise<LanguageModel[]> {
  const cached = fromCache("cohere");
  if (cached) return cached;

  try {
    const res = await fetch("https://api.cohere.com/v1/models", {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as {
      models?: Array<{
        name: string;
        endpoints?: string[];
        context_length?: number;
        features?: string[];
      }>;
    };
    const items = data.models ?? [];
    const models: LanguageModel[] = items
      .filter((m) => Array.isArray(m.endpoints) && m.endpoints.includes("chat"))
      .map((m) => ({
        apiName: m.name,
        displayName: m.name,
        description: "Chat model with tool support",
        contextWindow: m.context_length,
        type: "cloud" as const,
        supportsToolChoice: true,
      }));
    sortModels(models);
    toCache("cohere", models);
    logger.info(`[Cohere] Fetched ${models.length} models`);
    return models;
  } catch (e) {
    logger.warn("[Cohere] Fetch failed", e);
    return [];
  }
}

/** Elastic Agent Builder: list agents from Kibana. Uses baseUrl from settings or ELASTIC_AGENT_BUILDER_KIBANA_URL. */
export async function fetchModelsFromElastic(
  apiKey: string
): Promise<LanguageModel[]> {
  const cached = fromCache("elastic");
  if (cached) return cached;

  let baseUrl: string | undefined;
  try {
    const { readSettings } = await import("@/main/settings");
    baseUrl = (
      readSettings()?.providerSettings?.elastic as { baseUrl?: string } | undefined
    )?.baseUrl?.trim();
  } catch {
    // Renderer bundle — settings live in main; Elastic URL must be set there.
  }
  if (!baseUrl) {
    try {
      const { getEnvVar } = await import("@/ipc/utils/read_env");
      baseUrl = getEnvVar("ELASTIC_AGENT_BUILDER_KIBANA_URL")?.trim();
    } catch {
      // read_env is main-only (shell-env); stubbed in renderer.
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

export async function fetchModelsFromOpenRouter(
  apiKey: string
): Promise<LanguageModel[]> {
  const cached = fromCache("openrouter");
  if (cached) return cached;

  try {
    const res = await fetch("https://openrouter.ai/api/v1/models", {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        ...OPENROUTER_APP_HEADERS,
      },
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as {
      data?: Array<{
        id: string;
        name?: string;
        architecture?: {
          modality?: string;
        };
        context_length?: number;
      }>;
    };
    const items = data.data ?? [];
    const models: LanguageModel[] = items
      .filter((m) => {
        const id = (m.id ?? "").toLowerCase();
        if (!id || id.includes("embed")) return false;
        const mod = (m.architecture?.modality ?? "").toLowerCase();
        if (mod && mod !== "text" && mod !== "multimodal" && !mod.includes("text")) {
          return false;
        }
        return true;
      })
      .map((m) => ({
        apiName: m.id,
        displayName: m.name ?? m.id,
        description: "OpenRouter-hosted model",
        contextWindow: m.context_length,
        type: "cloud" as const,
        supportsToolChoice: true,
      }));
    sortModels(models);
    toCache("openrouter", models);
    logger.info(`[OpenRouter] Fetched ${models.length} models`);
    return models;
  } catch (e) {
    logger.warn("[OpenRouter] Fetch failed", e);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Open-weight providers (DeepSeek, Qwen, MiniMax, Kimi/Moonshot)
// All four expose an OpenAI-compatible Chat Completions API. These vendors ship
// new models every few days, so we DON'T hardcode model lists. Instead:
//   1. live GET /models from the provider (newest models + the key's real access)
//   2. fall back to the auto-updating models.dev catalog (refreshed hourly,
//      already filtered to tool-calling models) — qwen→alibaba, moonshot→moonshotai
//   3. otherwise empty (same graceful state as every other cloud provider)
// ---------------------------------------------------------------------------

async function fetchOpenWeightModels(
  providerId: "deepseek" | "qwen" | "minimax" | "moonshot",
  apiKey: string,
): Promise<LanguageModel[]> {
  // 1. Live provider /models — reflects newest models and the user's access.
  const live = await fetchOpenAICompatibleModels({
    providerId,
    url: `${OPENWEIGHT_PROVIDER_BASE_URLS[providerId]}/models`,
    apiKey,
  });
  if (live.length > 0) return live;

  // 2. models.dev — auto-updating catalog. Dynamic import keeps Electron/main-only
  //    deps out of any bundle that pulls in this module (mirrors the elastic fetcher).
  try {
    const { getModelsFromModelsDev } = await import("./models_dev");
    const fromDev = await getModelsFromModelsDev(providerId);
    if (fromDev.length > 0) {
      toCache(providerId, fromDev);
      return fromDev;
    }
  } catch (e) {
    logger.warn(`[${providerId}] models.dev fallback failed`, e);
  }

  // 3. No usable catalog (e.g. offline first run before models.dev cached) — show
  //    nothing rather than a stale hardcoded list; the user can add a custom model.
  return [];
}

export async function fetchModelsFromDeepSeek(
  apiKey: string,
): Promise<LanguageModel[]> {
  return fetchOpenWeightModels("deepseek", apiKey);
}

export async function fetchModelsFromQwen(
  apiKey: string,
): Promise<LanguageModel[]> {
  return fetchOpenWeightModels("qwen", apiKey);
}

export async function fetchModelsFromMiniMax(
  apiKey: string,
): Promise<LanguageModel[]> {
  return fetchOpenWeightModels("minimax", apiKey);
}

export async function fetchModelsFromMoonshot(
  apiKey: string,
): Promise<LanguageModel[]> {
  return fetchOpenWeightModels("moonshot", apiKey);
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
  nvidia_nim: fetchModelsFromNvidiaNim,
  cohere: fetchModelsFromCohere,
  perplexity: fetchModelsFromPerplexity,
  cerebras: fetchModelsFromCerebras,
  openrouter: fetchModelsFromOpenRouter,
  huggingface: fetchModelsFromHuggingFace,
  deepseek: fetchModelsFromDeepSeek,
  qwen: fetchModelsFromQwen,
  minimax: fetchModelsFromMiniMax,
  moonshot: fetchModelsFromMoonshot,
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
