/**
 * Effective context budget (tokens) for the model actually invoked — provider-agnostic.
 * Uses OpenRouter model catalog when available (same cache as tier limits), then heuristics.
 */

import type { LargeLanguageModel, UserSettings } from "@/lib/schemas";
import { getTierContextLimits, getCachedOpenRouterModelRow } from "@/lib/routing/tier-context-limits";
import { resolveTierLimitModelIds } from "@/lib/routing/context_budget_routing";
import { getOpenRouterModelIdForCompassTier } from "@/ipc/shared/compass_constants";

const SAFETY_FACTOR = 0.8;
/** When catalog + heuristics fail — safer than assuming 1M windows (local models). */
export const CONSERVATIVE_CONTEXT_LIMIT_TOKENS = 32_000;

function floorSafe(raw: number): number {
  return Math.max(4096, Math.floor(raw * SAFETY_FACTOR));
}

/**
 * Map synthetic / internal model selection to an OpenRouter-style id for catalog lookup.
 */
function openRouterCatalogId(model: LargeLanguageModel): string | null {
  const provider = model.provider?.trim() ?? "";
  const name = model.name?.trim() ?? "";
  if (!name) return null;
  if (provider === "compass") {
    return getOpenRouterModelIdForCompassTier(name) ?? null;
  }
  if (provider === "openrouter") {
    return name;
  }
  if (provider === "auto") {
    return name.includes("/") ? name : null;
  }
  return null;
}

function heuristicRawContextLength(model: LargeLanguageModel): number {
  const pid = (model.provider ?? "").toLowerCase();
  const mid = (model.name ?? "").toLowerCase();
  if (pid.includes("ollama")) return 8192;
  if (pid.includes("lmstudio") || pid.includes("lm_studio")) return 16384;
  if (pid.includes("groq")) return 131072;
  const hints: [string, number][] = [
    ["gpt-4o", 128000],
    ["gpt-4-turbo", 128000],
    ["gpt-4", 128000],
    ["gpt-3.5", 16384],
    ["claude-3", 200000],
    ["claude-sonnet", 200000],
    ["claude-opus", 200000],
    ["gemini-1.5", 1000000],
    ["gemini-pro", 32768],
    ["deepseek", 16384],
    ["llama", 8192],
    ["mistral", 8192],
    ["codellama", 16384],
    ["qwen", 32768],
  ];
  for (const [k, v] of hints) {
    if (mid.includes(k)) return v;
  }
  return 16384;
}

export type ResolvedModelContextLimit = {
  /** Budget tokens: raw context_length × 0.8 (same convention as getTierContextLimits). */
  tierLimit: number;
  /** Raw context window from catalog when known; else heuristic raw before safety factor. */
  rawContextLength: number | null;
};

/**
 * Resolve effective context budget for the model on this turn.
 * Warms OpenRouter model cache when needed so `getCachedOpenRouterModelRow` can resolve OR-backed models.
 */
export async function resolveModelContextLimit(
  model: LargeLanguageModel,
  settings: UserSettings,
): Promise<ResolvedModelContextLimit> {
  const ids = resolveTierLimitModelIds(settings, { effectiveModel: model });
  await getTierContextLimits(ids.fast, ids.balanced, ids.thinking);

  const catalogId = openRouterCatalogId(model);
  if (catalogId) {
    const row = getCachedOpenRouterModelRow(catalogId);
    const raw =
      row?.context_length ??
      (typeof row?.top_provider?.context_length === "number"
        ? row.top_provider.context_length
        : null);
    if (typeof raw === "number" && raw > 0) {
      return { tierLimit: floorSafe(raw), rawContextLength: raw };
    }
  }

  const rawHeuristic = heuristicRawContextLength(model);
  return {
    tierLimit: floorSafe(rawHeuristic),
    rawContextLength: rawHeuristic,
  };
}

/** Synchronous path when cache may already be warm (no network). */
export function resolveModelContextLimitSync(model: LargeLanguageModel): ResolvedModelContextLimit {
  const catalogId = openRouterCatalogId(model);
  if (catalogId) {
    const row = getCachedOpenRouterModelRow(catalogId);
    const raw =
      row?.context_length ??
      (typeof row?.top_provider?.context_length === "number"
        ? row.top_provider.context_length
        : null);
    if (typeof raw === "number" && raw > 0) {
      return { tierLimit: floorSafe(raw), rawContextLength: raw };
    }
  }
  const rawHeuristic = heuristicRawContextLength(model);
  return { tierLimit: floorSafe(rawHeuristic), rawContextLength: rawHeuristic };
}
