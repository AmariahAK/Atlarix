/**
 * Effective context budget (tokens) for the model actually invoked — provider-agnostic.
 * Uses OpenRouter model catalog when available (same cache as tier limits), then heuristics.
 */

import type { LargeLanguageModel, UserSettings } from "@/lib/schemas";
import { warmOpenRouterModelCache, getCachedOpenRouterModelRow } from "@/lib/routing/tier-context-limits";
import { getOpenRouterModelIdForCoreTier } from "@/ipc/shared/compass_constants";
import { findLanguageModel } from "@/ipc/utils/findLanguageModel";
import log from "electron-log";

const logger = log.scope("context-limit");

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

/**
 * W12 (v14.8.11): the per-model-name hint table (gpt-4/claude/deepseek/…)
 * was DELETED — identity-derived hardcoding rots (it served 128K for a 1M
 * DeepSeek v4 pro, compacting sessions ~8× early). Real limits now flow from
 * the provider APIs / OpenRouter catalog / models.dev at every resolution
 * step; what remains here is one generic last-resort constant plus
 * provider-RUNTIME placeholders for local servers whose real window is
 * fetched asynchronously (`getLocalModelContextLength`).
 */
export const GENERIC_CONTEXT_FALLBACK = 128_000;

export function heuristicRawContextLength(model: LargeLanguageModel): number {
  const pid = (model.provider ?? "").toLowerCase();
  // Conservative placeholders for local runtimes until their real-window
  // fetch resolves (seconds) — capability-derived (the runtime), not
  // model-identity-derived.
  if (pid.includes("ollama")) return 8192;
  if (pid.includes("lmstudio") || pid.includes("lm_studio")) return 16384;
  logger.warn(
    `[context-limit] generic fallback (${GENERIC_CONTEXT_FALLBACK}) for ${model.provider}/${model.name} — no provider/catalog/models.dev limit found; catalog may be stale`,
  );
  return GENERIC_CONTEXT_FALLBACK;
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
  // W12: a user override is authoritative EVERYWHERE — it used to affect only
  // the TokenBar (getEffectiveBudget) while the compaction denominator kept
  // resolving independently.
  const override = settings.tokenBudgetOverrides?.[model.provider ?? ""];
  if (typeof override === "number" && override > 0) {
    return { tierLimit: override, rawContextLength: override };
  }

  await warmOpenRouterModelCache();

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

  // BYOK cloud providers (the user's own Anthropic/OpenAI/Google/etc. key): use
  // the per-model window the provider API already reported (models.dev / native
  // /models), the same source the token bar uses via getContextWindowDetailed —
  // so the compaction budget matches the real window instead of guessing.
  try {
    const fetched = await findLanguageModel(model);
    if (fetched?.contextWindow && fetched.contextWindow > 0) {
      return {
        tierLimit: floorSafe(fetched.contextWindow * clamp),
        rawContextLength: fetched.contextWindow,
      };
    }
  } catch {
    // fall through to models.dev
  }

  // W12: models.dev direct lookup — covers native providers whose /models
  // endpoint reports no context length (e.g. DeepSeek), for which
  // findLanguageModel used to return a windowless row and this function fell
  // straight to a hardcoded guess.
  try {
    const { getModelsDevLimits } = await import("@/lib/models_dev");
    const limits = await getModelsDevLimits(model.provider ?? "", model.name ?? "");
    if (limits?.context && limits.context > 0) {
      return {
        tierLimit: floorSafe(limits.context * clamp),
        rawContextLength: limits.context,
      };
    }
  } catch {
    // fall through to the generic fallback
  }

  const rawHeuristic = heuristicRawContextLength(model);
  return {
    tierLimit: floorSafe(rawHeuristic * clamp),
    rawContextLength: rawHeuristic,
  };
}

