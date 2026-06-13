/**
 * v12 Tier 7D — BYOK per-turn spend estimation.
 *
 * "Bring any AI" needs spend visibility to stand alone. Compass (Core) already
 * meters tokens; BYOK providers had ZERO cost surface. This computes a
 * per-turn USD estimate from the SDK usage (input/output token split) × a
 * price table, and is emitted on `chat:response:end` for the token meter.
 *
 * Pricing precedence:
 *   1. OpenRouter actual cost — `providerMetadata.openrouter.usage.cost` is
 *      authoritative (includes cache discounts); callers pass it through as
 *      `actualCostUsd` and it wins outright.
 *   2. OpenRouter-routed models — the cached model row's `pricing`
 *      (per-token USD strings) is authoritative and always current.
 *   3. Direct BYOK (anthropic/openai/…) — a small static table below.
 * If neither yields a price, return null — NEVER guess a number (a wrong
 * spend figure is worse than no figure).
 *
 * v13.2 cache-aware: cached reads are billed at the provider's cache-read
 * rate (Anthropic 0.1×, OpenAI 0.1–0.5×), Anthropic cache writes at 1.25×.
 * Token semantics differ per provider family:
 *   - anthropic/bedrock-style: `inputTokens` EXCLUDES cache reads/writes
 *     (they arrive separately as cachedInputTokens / cacheCreationInputTokens)
 *   - OpenAI-style (openai, openrouter, google, openai-compatible):
 *     `inputTokens` INCLUDES cached reads; subtract before pricing.
 * Missing cache rate → those tokens fall back to the full input rate
 * (conservative overstatement, never null).
 *
 * Static Claude rates verified via the claude-api skill (per 1M tokens):
 *   Opus 4.x:   $5 in / $25 out      Sonnet 4.x: $3 in / $15 out
 *   Haiku 4.5:  $1 in / $5 out
 * Keep these in sync with the claude-api skill on model launches.
 */

import { getCachedOpenRouterModelRow } from "./tier-context-limits";

interface PerMillionRate {
  inputPerMtok: number;
  outputPerMtok: number;
  /** Cache-read rate; undefined → cached reads billed at inputPerMtok. */
  cacheReadPerMtok?: number;
  /** Cache-write rate (anthropic-style only); undefined → inputPerMtok. */
  cacheWritePerMtok?: number;
}

/** Pattern → rate. First match wins; order most-specific first. */
const STATIC_RATES: Array<{ test: RegExp; rate: PerMillionRate }> = [
  // Anthropic — cache read 0.1×, cache write (5-min TTL) 1.25×.
  {
    test: /claude.*opus/i,
    rate: {
      inputPerMtok: 5,
      outputPerMtok: 25,
      cacheReadPerMtok: 0.5,
      cacheWritePerMtok: 6.25,
    },
  },
  {
    test: /claude.*sonnet/i,
    rate: {
      inputPerMtok: 3,
      outputPerMtok: 15,
      cacheReadPerMtok: 0.3,
      cacheWritePerMtok: 3.75,
    },
  },
  {
    test: /claude.*haiku/i,
    rate: {
      inputPerMtok: 1,
      outputPerMtok: 5,
      cacheReadPerMtok: 0.1,
      cacheWritePerMtok: 1.25,
    },
  },
  // OpenAI (direct BYOK; OpenRouter rows override when routed). Cached input
  // rates from the published price list; writes are free (inside inputTokens).
  {
    test: /gpt-5/i,
    rate: { inputPerMtok: 1.25, outputPerMtok: 10, cacheReadPerMtok: 0.125 },
  },
  {
    test: /gpt-4\.1\b/i,
    rate: { inputPerMtok: 2, outputPerMtok: 8, cacheReadPerMtok: 0.5 },
  },
  {
    test: /gpt-4o-mini/i,
    rate: { inputPerMtok: 0.15, outputPerMtok: 0.6, cacheReadPerMtok: 0.075 },
  },
  {
    test: /gpt-4o/i,
    rate: { inputPerMtok: 2.5, outputPerMtok: 10, cacheReadPerMtok: 1.25 },
  },
  {
    test: /o3-mini/i,
    rate: { inputPerMtok: 1.1, outputPerMtok: 4.4, cacheReadPerMtok: 0.55 },
  },
];

export interface TurnUsageSplit {
  /**
   * ai@6: flat `inputTokens` is the structured `total` — cache-INCLUSIVE for
   * every provider (Anthropic's = input + cacheCreation + cacheRead).
   */
  inputTokens: number;
  outputTokens: number;
  /** Cache-read tokens (`usage.inputTokenDetails.cacheReadTokens`). */
  cachedInputTokens?: number;
  /** Cache-write tokens (`usage.inputTokenDetails.cacheWriteTokens`). */
  cacheCreationInputTokens?: number;
}

/** Pull input/output token counts from an AI-SDK usage object (provider-shape tolerant). */
export function inputOutputTokensFromUsage(
  usage: unknown,
): TurnUsageSplit | null {
  if (!usage || typeof usage !== "object") return null;
  const u = usage as Record<string, unknown>;
  const input =
    typeof u.inputTokens === "number"
      ? u.inputTokens
      : typeof u.promptTokens === "number"
        ? u.promptTokens
        : null;
  const output =
    typeof u.outputTokens === "number"
      ? u.outputTokens
      : typeof u.completionTokens === "number"
        ? u.completionTokens
        : null;
  if (input == null || output == null) return null;
  // ai@6 detail fields first; deprecated top-level `cachedInputTokens` as
  // fallback (still populated, marked deprecated in v6).
  const details = (u.inputTokenDetails ?? {}) as Record<string, unknown>;
  const asCount = (v: unknown): number | undefined =>
    typeof v === "number" && Number.isFinite(v) && v > 0 ? v : undefined;
  const cached = asCount(details.cacheReadTokens) ?? asCount(u.cachedInputTokens);
  const cacheWrite = asCount(details.cacheWriteTokens);
  return {
    inputTokens: input,
    outputTokens: output,
    ...(cached != null ? { cachedInputTokens: cached } : {}),
    ...(cacheWrite != null ? { cacheCreationInputTokens: cacheWrite } : {}),
  };
}

function rateForModel(model: {
  name: string;
  builtinProviderId?: string;
}): PerMillionRate | null {
  // 1. OpenRouter cached row (per-TOKEN USD strings → per-MTok).
  if (model.builtinProviderId === "openrouter" || model.name.includes("/")) {
    const row = getCachedOpenRouterModelRow(model.name) as
      | {
          pricing?: {
            prompt?: string;
            completion?: string;
            input_cache_read?: string;
            input_cache_write?: string;
          };
        }
      | undefined;
    const prompt = row?.pricing?.prompt;
    const completion = row?.pricing?.completion;
    if (prompt != null && completion != null) {
      const p = Number.parseFloat(prompt);
      const c = Number.parseFloat(completion);
      if (Number.isFinite(p) && Number.isFinite(c)) {
        const read = Number.parseFloat(row?.pricing?.input_cache_read ?? "");
        const write = Number.parseFloat(row?.pricing?.input_cache_write ?? "");
        return {
          inputPerMtok: p * 1_000_000,
          outputPerMtok: c * 1_000_000,
          ...(Number.isFinite(read)
            ? { cacheReadPerMtok: read * 1_000_000 }
            : {}),
          ...(Number.isFinite(write)
            ? { cacheWritePerMtok: write * 1_000_000 }
            : {}),
        };
      }
    }
  }
  // 2. Static table.
  for (const { test, rate } of STATIC_RATES) {
    if (test.test(model.name)) return rate;
  }
  return null;
}

/**
 * Does this provider's `inputTokens` EXCLUDE cache tokens (anthropic-style)?
 * Direct Anthropic and Bedrock report cache reads/writes separately; the
 * OpenAI wire shape (openai, openrouter, google, custom proxies) folds cached
 * reads into the prompt/input total.
 */

/**
 * Estimate the USD cost of a turn. Returns null when the model's price is
 * unknown (the caller omits the cost line rather than showing a guess) or
 * when the provider is Compass/Core (metered separately, not BYOK).
 *
 * `actualCostUsd` (OpenRouter's per-request `usage.cost`, already
 * cache-discounted) wins over any estimate when present and positive.
 *
 * ai@6 normalized the token semantics across providers: flat `inputTokens`
 * is the cache-INCLUSIVE total, so one formula prices every provider —
 * full-rate tokens = total − cacheRead − cacheWrite; cache reads at the
 * read rate; cache writes at the write rate (≈ input rate where a provider
 * has no write surcharge, e.g. OpenAI reports no cacheWrite at all).
 */
export function estimateTurnCostUsd(
  model: { name: string; builtinProviderId?: string },
  usage: TurnUsageSplit | null,
  actualCostUsd?: number | null,
): number | null {
  if (model.builtinProviderId === "compass") return null; // Core is token-metered
  if (typeof actualCostUsd === "number" && actualCostUsd > 0) {
    return Math.round(actualCostUsd * 1e6) / 1e6;
  }
  if (!usage) return null;
  const rate = rateForModel(model);
  if (!rate) return null;

  const cachedRead = usage.cachedInputTokens ?? 0;
  const cacheWrite = usage.cacheCreationInputTokens ?? 0;
  const readRate = rate.cacheReadPerMtok ?? rate.inputPerMtok;
  const writeRate = rate.cacheWritePerMtok ?? rate.inputPerMtok;

  const fullRateInput = Math.max(0, usage.inputTokens - cachedRead - cacheWrite);
  const cost =
    (fullRateInput / 1_000_000) * rate.inputPerMtok +
    (cachedRead / 1_000_000) * readRate +
    (cacheWrite / 1_000_000) * writeRate +
    (usage.outputTokens / 1_000_000) * rate.outputPerMtok;
  return Math.round(cost * 1e6) / 1e6; // round to micro-dollars
}
