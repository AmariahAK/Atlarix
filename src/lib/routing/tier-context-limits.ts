/**
 * Dynamic per-tier context limits from OpenRouter's public models API.
 * Cached 24h; no hardcoded model windows for budgeting beyond fallbacks.
 */

export interface TierContextLimits {
  fast: number;
  balanced: number;
  thinking: number;
}

const SAFETY_FACTOR = 0.8;
const FALLBACK_LIMIT = 100_000;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

interface OpenRouterModelRow {
  id: string;
  context_length?: number;
}

interface OpenRouterModelsResponse {
  data?: OpenRouterModelRow[];
}

let cachedLimits: TierContextLimits | null = null;
let cacheTimestamp = 0;
let cacheKey = "";

function fallbackLimitsOnFetchFailure(): TierContextLimits {
  return {
    fast: Math.floor(1_000_000 * SAFETY_FACTOR),
    balanced: FALLBACK_LIMIT,
    thinking: FALLBACK_LIMIT,
  };
}

export async function getTierContextLimits(
  fastModelId: string,
  balancedModelId: string,
  thinkingModelId: string,
): Promise<TierContextLimits> {
  const key = `${fastModelId}\0${balancedModelId}\0${thinkingModelId}`;
  if (
    cachedLimits &&
    cacheKey === key &&
    Date.now() - cacheTimestamp < CACHE_TTL_MS
  ) {
    return cachedLimits;
  }

  try {
    const res = await fetch("https://openrouter.ai/api/v1/models", {
      headers: { "Content-Type": "application/json" },
    });
    if (!res.ok) {
      return fallbackLimitsOnFetchFailure();
    }
    const json = (await res.json()) as OpenRouterModelsResponse;
    const data = Array.isArray(json.data) ? json.data : [];

    const getLimit = (id: string): number => {
      if (!id.trim()) return FALLBACK_LIMIT;
      const model = data.find((m) => m.id === id);
      if (model?.context_length == null || typeof model.context_length !== "number") {
        return FALLBACK_LIMIT;
      }
      return Math.floor(model.context_length * SAFETY_FACTOR);
    };

    cachedLimits = {
      fast: getLimit(fastModelId),
      balanced: getLimit(balancedModelId),
      thinking: getLimit(thinkingModelId),
    };
    cacheKey = key;
    cacheTimestamp = Date.now();
    return cachedLimits;
  } catch {
    return fallbackLimitsOnFetchFailure();
  }
}

export async function warmTierContextCache(
  fastModelId: string,
  balancedModelId: string,
  thinkingModelId: string,
): Promise<void> {
  await getTierContextLimits(fastModelId, balancedModelId, thinkingModelId);
}
