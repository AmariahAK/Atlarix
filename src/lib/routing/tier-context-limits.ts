/**
 * Dynamic per-tier context limits from OpenRouter's public models API.
 * Cached 24h; no hardcoded model windows for budgeting beyond fallbacks.
 * Also caches full model rows for reasoning-capability lookup (same refresh).
 */

import { OPENROUTER_APP_HEADERS } from "@/ipc/shared/openrouter_app_headers";

export interface TierContextLimits {
  fast: number;
  balanced: number;
  thinking: number;
}

const SAFETY_FACTOR = 0.8;
const FALLBACK_LIMIT = 100_000;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

export interface OpenRouterModelRowExtended {
  id: string;
  context_length?: number;
  /** Present on some OpenRouter API responses; shape may vary. */
  supported_parameters?: unknown;
  architecture?: { modality?: string; tokenizer?: string };
  top_provider?: { name?: string; context_length?: number };
}

interface OpenRouterModelsResponse {
  data?: OpenRouterModelRowExtended[];
}

let cachedLimits: TierContextLimits | null = null;
let cacheTimestamp = 0;
let cacheKey = "";
/** Populated on last successful models fetch; keyed by OpenRouter model id (e.g. anthropic/claude-3.5-sonnet). */
let openRouterModelsById: Map<string, OpenRouterModelRowExtended> | null = null;

function fallbackLimitsOnFetchFailure(): TierContextLimits {
  // Last-resort fallbacks when the OpenRouter models fetch fails. These are
  // intentionally generous (200K each) — they should never be the operating
  // limit in practice; real limits come from the live OpenRouter response.
  // Modern models routinely exceed 128K (Qwen3.5-Flash advertises 1M); a
  // conservative 32K cap here caused false "context full" warnings and
  // premature compaction.
  return {
    fast: 200_000,
    balanced: 200_000,
    thinking: 200_000,
  };
}

function rebuildModelIndex(data: OpenRouterModelRowExtended[]): void {
  const m = new Map<string, OpenRouterModelRowExtended>();
  for (const row of data) {
    if (row?.id && typeof row.id === "string") {
      m.set(row.id, row);
    }
  }
  openRouterModelsById = m;
}

/** Sync lookup from the last successful OpenRouter models fetch (same 24h cache as tier limits). */
export function getCachedOpenRouterModelRow(
  modelId: string,
): OpenRouterModelRowExtended | undefined {
  if (!modelId.trim() || !openRouterModelsById) return undefined;
  return openRouterModelsById.get(modelId.trim());
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
      headers: {
        ...OPENROUTER_APP_HEADERS,
        "Content-Type": "application/json",
      },
    });
    if (!res.ok) {
      return fallbackLimitsOnFetchFailure();
    }
    const json = (await res.json()) as OpenRouterModelsResponse;
    const data = Array.isArray(json.data) ? json.data : [];
    rebuildModelIndex(data);

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
