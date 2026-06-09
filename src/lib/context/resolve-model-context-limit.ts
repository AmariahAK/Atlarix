/**
 * Effective context budget (tokens) for the model actually invoked — provider-agnostic.
 * Uses OpenRouter model catalog when available (same cache as tier limits), then heuristics.
 */

import type { LargeLanguageModel, UserSettings } from "@/lib/schemas";
import { getTierContextLimits, getCachedOpenRouterModelRow } from "@/lib/routing/tier-context-limits";
import { resolveTierLimitModelIds } from "@/lib/routing/context_budget_routing";
import { getOpenRouterModelIdForCoreTier } from "@/ipc/shared/compass_constants";

const SAFETY_FACTOR = 0.8;

function floorSafe(raw: number): number {
  return Math.max(4096, Math.floor(raw * SAFETY_FACTOR));
}

// ── v11.1: real local-model context windows ─────────────────────────────────
// Ollama (`POST /api/show` → model_info.*context_length*) and LM Studio
// (`GET /api/v0/models` → max_context_length) expose the true window — far
// better than the old hardcoded 8192/16384 guesses. Best-effort with cache;
// offline/unknown falls back to the heuristics below.

const localContextCache = new Map<string, number | null>();
const localContextInFlight = new Set<string>();

function localCacheKey(provider: string, name: string): string {
  return `${provider}:${name}`;
}

async function fetchOllamaContextLength(name: string): Promise<number | null> {
  const { getOllamaApiUrl } = await import(
    "@/ipc/handlers/local_model_ollama_handler"
  );
  const res = await fetch(`${getOllamaApiUrl()}/api/show`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
    signal: AbortSignal.timeout(3_000),
  });
  if (!res.ok) return null;
  const json = (await res.json()) as { model_info?: Record<string, unknown> };
  const info = json.model_info;
  if (!info || typeof info !== "object") return null;
  // Key is architecture-prefixed (e.g. "llama.context_length").
  for (const [key, value] of Object.entries(info)) {
    if (key.endsWith("context_length") && typeof value === "number" && value > 0) {
      return value;
    }
  }
  return null;
}

async function fetchLmStudioContextLength(name: string): Promise<number | null> {
  const { LM_STUDIO_BASE_URL } = await import("@/ipc/utils/lm_studio_utils");
  const res = await fetch(`${LM_STUDIO_BASE_URL}/api/v0/models`, {
    signal: AbortSignal.timeout(3_000),
  });
  if (!res.ok) return null;
  const json = (await res.json()) as {
    data?: { id?: string; max_context_length?: number }[];
  };
  const row = json.data?.find((m) => m.id === name);
  return typeof row?.max_context_length === "number" && row.max_context_length > 0
    ? row.max_context_length
    : null;
}

/**
 * Cached real context window for local providers; returns null when unknown
 * (caller falls back to heuristics). Misses populate in the background so the
 * first turn never blocks on a dead local server.
 */
function getLocalModelContextLength(
  provider: string,
  name: string,
): number | null {
  const key = localCacheKey(provider, name);
  if (localContextCache.has(key)) return localContextCache.get(key) ?? null;
  if (!localContextInFlight.has(key)) {
    localContextInFlight.add(key);
    const fetcher = provider.includes("ollama")
      ? fetchOllamaContextLength(name)
      : fetchLmStudioContextLength(name);
    void fetcher
      .then((len) => {
        localContextCache.set(key, len);
        if (len) {
          // eslint-disable-next-line no-console
          console.log(`[context] ${provider}/${name} real context_length=${len}`);
        }
      })
      .catch(() => {
        localContextCache.set(key, null);
      })
      .finally(() => {
        localContextInFlight.delete(key);
      });
  }
  return null;
}

// ── v11.1: provider-overflow feedback loop ──────────────────────────────────
// When a provider rejects a dispatch with "context length exceeded", our
// estimate was too high — clamp this model's effective window down 15% so the
// retry (and future turns) budget more conservatively. Compounds on repeat.

const overflowClampByModel = new Map<string, number>();

export function reportContextOverflowForModel(model: {
  provider?: string | null;
  name?: string | null;
}): void {
  const key = localCacheKey(model.provider ?? "", model.name ?? "");
  const current = overflowClampByModel.get(key) ?? 1;
  const next = Math.max(0.4, current * 0.85);
  overflowClampByModel.set(key, next);
}

function overflowClampFor(model: LargeLanguageModel): number {
  return overflowClampByModel.get(
    localCacheKey(model.provider ?? "", model.name ?? ""),
  ) ?? 1;
}

/**
 * Map synthetic / internal model selection to an OpenRouter-style id for catalog lookup.
 */
function openRouterCatalogId(model: LargeLanguageModel): string | null {
  const provider = model.provider?.trim() ?? "";
  const name = model.name?.trim() ?? "";
  if (!name) return null;
  if (provider === "compass") {
    return getOpenRouterModelIdForCoreTier(name) ?? null;
  }
  if (provider === "openrouter") {
    return name;
  }
  if (provider === "auto") {
    return name.includes("/") ? name : null;
  }
  return null;
}

export function heuristicRawContextLength(model: LargeLanguageModel): number {
  const pid = (model.provider ?? "").toLowerCase();
  const mid = (model.name ?? "").toLowerCase();
  if (pid.includes("ollama")) return 8192;
  if (pid.includes("lmstudio") || pid.includes("lm_studio")) return 16384;
  if (pid.includes("groq")) return 131072;
  // Bias these slightly HIGH for unknown/catalog-miss cases: the provider
  // overflow feedback loop (reportContextOverflowForModel) self-corrects an
  // over-estimate by clamping 15% on a real "context exceeded" rejection,
  // whereas an UNDER-estimate causes permanent premature compaction with no
  // recovery signal. Values reflect modern (2024+) model windows.
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
    ["deepseek", 128000], // V3/R1 are 128K+
    ["minimax", 1000000], // MiniMax-Text-01 ≈ 1M
    ["llama", 131072], // Llama 3.1 = 128K
    ["mistral", 131072], // Mistral Large = 128K
    ["codellama", 16384],
    ["qwen", 131072], // modern Qwen 128K+ (many up to 1M)
  ];
  for (const [k, v] of hints) {
    if (mid.includes(k)) return v;
  }
  // Modern floor for any unlisted frontier API model (covers new OpenRouter
  // additions); local providers are handled by the explicit ollama/lmstudio
  // branches above and their real-fetch path.
  return 128000;
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

  const clamp = overflowClampFor(model);

  const catalogId = openRouterCatalogId(model);
  if (catalogId) {
    const row = getCachedOpenRouterModelRow(catalogId);
    const raw =
      row?.context_length ??
      (typeof row?.top_provider?.context_length === "number"
        ? row.top_provider.context_length
        : null);
    if (typeof raw === "number" && raw > 0) {
      return { tierLimit: floorSafe(raw * clamp), rawContextLength: raw };
    }
  }

  // v11.1: local providers report their REAL window (cached async fetch).
  const pid = (model.provider ?? "").toLowerCase();
  if (pid.includes("ollama") || pid.includes("lmstudio") || pid.includes("lm_studio")) {
    const real = getLocalModelContextLength(pid, model.name ?? "");
    if (typeof real === "number" && real > 0) {
      return { tierLimit: floorSafe(real * clamp), rawContextLength: real };
    }
  }

  const rawHeuristic = heuristicRawContextLength(model);
  return {
    tierLimit: floorSafe(rawHeuristic * clamp),
    rawContextLength: rawHeuristic,
  };
}

