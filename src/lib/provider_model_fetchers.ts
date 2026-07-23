/**
 * Provider-native model fetchers
 * ==============================
 * A best-effort OVERLAY on the models.dev catalog, not a replacement for it.
 * `getLanguageModels` (src/ipc/shared/language_model_helpers.ts) unions the
 * catalog with whatever these return — see `mergeByApiName` there for the
 * invariant and the bug history behind it.
 *
 * A fetcher earns its place here only by knowing something the hourly catalog
 * cannot:
 *   - day-one model launches (openai, anthropic, google, and the open-weight
 *     four, which ship every few days)
 *   - live per-model economics (openrouter's pricing + `top_provider` ceilings)
 *   - a source the catalog doesn't cover AT ALL (elastic lists Kibana agents
 *     from a user's self-hosted instance)
 *
 * Everything else was deleted in the catalog-as-floor pass: cohere, mistral,
 * xai, together and groq each reimplemented bespoke pagination or id-munging to
 * produce a strict SUBSET of catalog rows with worse display names, and were
 * the source of every recent "models missing from the picker" bug. Adding a
 * fetcher back needs a reason from the list above — "the provider has a
 * /models endpoint" is not one.
 */

import log from "electron-log";
import type { LanguageModel } from "@/ipc/ipc_types";
import { OPENROUTER_APP_HEADERS } from "@/ipc/shared/openrouter_app_headers";
import { OPENWEIGHT_PROVIDER_BASE_URLS } from "@/ipc/shared/language_model_constants";

const logger = log.scope("provider_fetchers");

const CACHE_MS = 5 * 60 * 1000; // 5 min per-provider cache
const cache = new Map<string, { models: LanguageModel[]; ts: number }>();

/**
 * Hard stop for every cursor-paginated fetch below. With max page sizes the
 * real catalogs fit in one or two pages; this only exists so a provider
 * returning a self-referential cursor can't spin forever.
 */
const MAX_PAGES = 10;

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

/**
 * OpenAI: `/v1/models` carries no capability metadata, so we classify by id.
 *
 * This is a DENYLIST on purpose. The previous allowlist (`gpt-`/`o1-`/`o3-`)
 * failed in both directions against OpenAI's naming: reasoning models without a
 * trailing dash (`o3`) or on a newer number (`o4-mini`) were dropped, while
 * non-chat models that happen to start with `gpt-` (`gpt-image-*`,
 * `gpt-realtime-*`, `gpt-4o-transcribe`) sailed through and were listed as
 * tool-capable chat models. Naming a family we can't serve is stable; trying to
 * enumerate every family we CAN serve is not — new ones ship faster than releases.
 *
 * Matched as substrings so variants (`-mini-tts`, `gpt-4o-mini-transcribe`) are
 * covered without another entry. The shared models.dev tool-capability funnel in
 * `fetchModelsFromProvider` catches whatever slips past.
 */
const OPENAI_NON_CHAT_MARKERS = [
  "embedding",
  "whisper",
  "dall-e",
  "tts",
  "audio",
  "realtime",
  "transcribe",
  "image",
  "moderation",
  "sora",
  "search-preview",
  "computer-use",
  // Legacy base-completion engines — still listed by /v1/models, no chat or
  // tool support, and too old for the models.dev catalog to vouch for.
  "davinci",
  "babbage",
  "curie",
];

function isOpenAIChatModel(id: string): boolean {
  const lower = id.toLowerCase();
  return !OPENAI_NON_CHAT_MARKERS.some((marker) => lower.includes(marker));
}

export async function fetchModelsFromOpenAI(
  apiKey: string,
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
        displayName: m.id
          .replace(/^gpt-/, "GPT-")
          .replace(/^o1-/, "O1-")
          .replace(/^o3-/, "O3-"),
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
  apiKey: string,
): Promise<LanguageModel[]> {
  const cached = fromCache("anthropic");
  if (cached) return cached;

  try {
    // `limit` defaults to 20 and the endpoint is cursor-paginated, so a single
    // unparameterized request silently truncates the catalog. Ask for the max
    // page size and follow `has_more`/`last_id` to the end.
    type AnthropicModel = {
      id: string;
      display_name?: string;
      max_input_tokens?: number;
      max_tokens?: number;
    };
    const items: AnthropicModel[] = [];
    let after: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const url = new URL("https://api.anthropic.com/v1/models");
      url.searchParams.set("limit", "1000");
      if (after) url.searchParams.set("after_id", after);
      const res = await fetch(url, {
        headers: {
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as {
        data?: AnthropicModel[];
        has_more?: boolean;
        last_id?: string;
      };
      items.push(...(data.data ?? []));
      if (!data.has_more || !data.last_id) break;
      after = data.last_id;
    }
    // Anthropic reports real per-model limits — authoritative, so prefer them
    // over the models.dev enrichment that would otherwise fill the gap.
    const models: LanguageModel[] = items.map((m) => ({
      apiName: m.id,
      displayName: m.display_name ?? m.id,
      description: "Claude model with tool support",
      ...(m.max_input_tokens ? { contextWindow: m.max_input_tokens } : {}),
      ...(m.max_tokens ? { maxOutputTokens: m.max_tokens } : {}),
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
  apiKey: string,
): Promise<LanguageModel[]> {
  const cached = fromCache("google");
  if (cached) return cached;

  try {
    // `pageSize` defaults to 50 and the list is page-token paginated — Gemini's
    // catalog is past that, so an unparameterized call drops models. Key moves
    // to the header: query strings end up in logs and proxy traces.
    type GoogleModel = {
      name: string;
      displayName?: string;
      supportedGenerationMethods?: string[];
      inputTokenLimit?: number;
      outputTokenLimit?: number;
    };
    const items: GoogleModel[] = [];
    let pageToken: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const url = new URL(
        "https://generativelanguage.googleapis.com/v1beta/models",
      );
      url.searchParams.set("pageSize", "1000");
      if (pageToken) url.searchParams.set("pageToken", pageToken);
      const res = await fetch(url, {
        headers: { "x-goog-api-key": apiKey },
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as {
        models?: GoogleModel[];
        nextPageToken?: string;
      };
      items.push(...(data.models ?? []));
      if (!data.nextPageToken) break;
      pageToken = data.nextPageToken;
    }
    const models: LanguageModel[] = items
      .filter(
        (m) =>
          m.supportedGenerationMethods?.includes("generateContent") ||
          m.supportedGenerationMethods?.includes("generateMessage"),
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

export async function fetchModelsFromPerplexity(
  apiKey: string,
): Promise<LanguageModel[]> {
  const cached = fromCache("perplexity");
  if (cached) return cached;

  // Perplexity's generic GET /v1/models lists Agent API models (including
  // non-Sonar), so it isn't a usable selectable list — the Sonar family is what
  // this provider offers. That family comes from the models.dev catalog rather
  // than a hardcoded array so the limits and pricing stay live.
  //
  // IMPORTANT: models.dev marks every Sonar model `tool_call: false`, and it is
  // right — Sonar does its own grounded retrieval and does not drive
  // user-defined tools. The shared tool funnel would therefore drop all four,
  // so this fetcher returns them explicitly and marks them honestly:
  // `supportsToolChoice: false`. They stay selectable for grounded Q&A while
  // the picker stops advertising agent-loop capability they don't have.
  void apiKey; // Key presence is required by the caller; not needed to list.
  try {
    const { getModelsDevCatalogRows } = await import("./models_dev");
    const rows = await getModelsDevCatalogRows("perplexity", {
      requireToolCall: false,
    });
    const models: LanguageModel[] = rows.map((m) => ({
      ...m,
      supportsToolChoice: false,
    }));
    if (models.length > 0) {
      sortModels(models);
      toCache("perplexity", models);
      logger.info(`[Perplexity] Fetched ${models.length} models`);
      return models;
    }
  } catch (e) {
    logger.warn("[Perplexity] models.dev lookup failed", e);
  }
  return [];
}

/** Elastic Agent Builder: list agents from Kibana. Uses baseUrl from settings or ELASTIC_AGENT_BUILDER_KIBANA_URL. */
export async function fetchModelsFromElastic(
  apiKey: string,
): Promise<LanguageModel[]> {
  const cached = fromCache("elastic");
  if (cached) return cached;

  let baseUrl: string | undefined;
  try {
    const { readSettings } = await import("@/main/settings");
    baseUrl = (
      readSettings()?.providerSettings?.elastic as
        | { baseUrl?: string }
        | undefined
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
    logger.warn(
      "[Elastic] Kibana URL not set in Settings or ELASTIC_AGENT_BUILDER_KIBANA_URL; cannot list agents",
    );
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
  apiKey: string,
): Promise<LanguageModel[]> {
  const cached = fromCache("openrouter");
  if (cached) return cached;

  try {
    // `supported_parameters=tools` filters server-side. Roughly a fifth of
    // OpenRouter's catalog (image/video/moderation/router models) can't tool-call,
    // and every one of them used to be listed as agent-capable.
    const res = await fetch(
      "https://openrouter.ai/api/v1/models?supported_parameters=tools",
      {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          ...OPENROUTER_APP_HEADERS,
        },
        signal: AbortSignal.timeout(20_000),
      },
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as {
      data?: Array<{
        id: string;
        name?: string;
        architecture?: {
          modality?: string;
        };
        context_length?: number;
        // The serving provider's real ceilings — `context_length` at the top
        // level is the model's, which can exceed what the endpoint allows.
        top_provider?: {
          context_length?: number;
          max_completion_tokens?: number;
        };
        // OpenRouter reports per-TOKEN USD prices as strings ("0.0000003").
        pricing?: { prompt?: string; completion?: string };
      }>;
    };
    const items = data.data ?? [];
    // Per-token USD string → USD per 1M tokens (the picker's PriceBadge unit).
    const perMillion = (v?: string): number | undefined => {
      const n = v ? Number.parseFloat(v) : Number.NaN;
      return Number.isFinite(n) ? n * 1_000_000 : undefined;
    };
    const models: LanguageModel[] = items
      .filter((m) => {
        const id = (m.id ?? "").toLowerCase();
        if (!id || id.includes("embed")) return false;
        const mod = (m.architecture?.modality ?? "").toLowerCase();
        if (
          mod &&
          mod !== "text" &&
          mod !== "multimodal" &&
          !mod.includes("text")
        ) {
          return false;
        }
        return true;
      })
      .map((m) => {
        const input = perMillion(m.pricing?.prompt);
        const output = perMillion(m.pricing?.completion);
        // Attach cost only for PAID models — a $0 model stays "Free" in the badge.
        const cost =
          (input ?? 0) > 0 || (output ?? 0) > 0
            ? { input: input ?? 0, output: output ?? 0 }
            : undefined;
        return {
          apiName: m.id,
          displayName: m.name ?? m.id,
          description: "OpenRouter-hosted model",
          contextWindow: m.top_provider?.context_length ?? m.context_length,
          ...(m.top_provider?.max_completion_tokens
            ? { maxOutputTokens: m.top_provider.max_completion_tokens }
            : {}),
          type: "cloud" as const,
          supportsToolChoice: true,
          ...(cost ? { cost } : {}),
        };
      });
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

const FETCHERS: Record<string, (apiKey: string) => Promise<LanguageModel[]>> = {
  openai: fetchModelsFromOpenAI,
  anthropic: fetchModelsFromAnthropic,
  google: fetchModelsFromGoogle,
  elastic: fetchModelsFromElastic,
  perplexity: fetchModelsFromPerplexity,
  openrouter: fetchModelsFromOpenRouter,
  deepseek: fetchModelsFromDeepSeek,
  qwen: fetchModelsFromQwen,
  minimax: fetchModelsFromMiniMax,
  moonshot: fetchModelsFromMoonshot,
};

export async function fetchModelsFromProvider(
  providerId: string,
  apiKey: string,
): Promise<LanguageModel[]> {
  const key = providerId === "together" ? "togetherai" : providerId;
  const fetcher = FETCHERS[key];
  if (!fetcher) return [];
  const models = await fetcher(apiKey);
  // W12 (v14.8.11): one funnel, every provider — fill missing context/output
  // limits from models.dev so downstream resolution never needs hardcoded
  // guesses. Dynamic import keeps main-only deps out of renderer bundles.
  try {
    const { enrichModelsWithModelsDevLimits, annotateToolCapability } =
      await import("./models_dev");
    const enriched = await enrichModelsWithModelsDevLimits(key, models);
    // Same funnel: drop models the catalog says can't tool-call. Provider
    // endpoints mostly don't report tool support, so without this the native
    // path listed image/realtime/guard models as agent-capable.
    return await annotateToolCapability(key, enriched);
  } catch {
    return models;
  }
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
