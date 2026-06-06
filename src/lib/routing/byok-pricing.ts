/**
 * v12 Tier 7D — BYOK per-turn spend estimation.
 *
 * "Bring any AI" needs spend visibility to stand alone. Compass (Core) already
 * meters tokens; BYOK providers had ZERO cost surface. This computes a
 * per-turn USD estimate from the SDK usage (input/output token split) × a
 * price table, and is emitted on `chat:response:end` for the token meter.
 *
 * Pricing precedence:
 *   1. OpenRouter-routed models — the cached model row's `pricing`
 *      (per-token USD strings) is authoritative and always current.
 *   2. Direct BYOK (anthropic/openai/…) — a small static table below.
 * If neither yields a price, return null — NEVER guess a number (a wrong
 * spend figure is worse than no figure).
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
}

/** Pattern → rate. First match wins; order most-specific first. */
const STATIC_RATES: Array<{ test: RegExp; rate: PerMillionRate }> = [
  // Anthropic
  { test: /claude.*opus/i, rate: { inputPerMtok: 5, outputPerMtok: 25 } },
  { test: /claude.*sonnet/i, rate: { inputPerMtok: 3, outputPerMtok: 15 } },
  { test: /claude.*haiku/i, rate: { inputPerMtok: 1, outputPerMtok: 5 } },
  // OpenAI (direct BYOK; OpenRouter rows override when routed)
  { test: /gpt-5/i, rate: { inputPerMtok: 1.25, outputPerMtok: 10 } },
  { test: /gpt-4\.1\b/i, rate: { inputPerMtok: 2, outputPerMtok: 8 } },
  { test: /gpt-4o-mini/i, rate: { inputPerMtok: 0.15, outputPerMtok: 0.6 } },
  { test: /gpt-4o/i, rate: { inputPerMtok: 2.5, outputPerMtok: 10 } },
  { test: /o3-mini/i, rate: { inputPerMtok: 1.1, outputPerMtok: 4.4 } },
];

export interface TurnUsageSplit {
  inputTokens: number;
  outputTokens: number;
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
  return { inputTokens: input, outputTokens: output };
}

function rateForModel(model: {
  name: string;
  builtinProviderId?: string;
}): PerMillionRate | null {
  // 1. OpenRouter cached row (per-TOKEN USD strings → per-MTok).
  if (model.builtinProviderId === "openrouter" || model.name.includes("/")) {
    const row = getCachedOpenRouterModelRow(model.name) as
      | { pricing?: { prompt?: string; completion?: string } }
      | undefined;
    const prompt = row?.pricing?.prompt;
    const completion = row?.pricing?.completion;
    if (prompt != null && completion != null) {
      const p = Number.parseFloat(prompt);
      const c = Number.parseFloat(completion);
      if (Number.isFinite(p) && Number.isFinite(c)) {
        return { inputPerMtok: p * 1_000_000, outputPerMtok: c * 1_000_000 };
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
 * Estimate the USD cost of a turn. Returns null when the model's price is
 * unknown (the caller omits the cost line rather than showing a guess) or
 * when the provider is Compass/Core (metered separately, not BYOK).
 */
export function estimateTurnCostUsd(
  model: { name: string; builtinProviderId?: string },
  usage: TurnUsageSplit | null,
): number | null {
  if (!usage) return null;
  if (model.builtinProviderId === "compass") return null; // Core is token-metered
  const rate = rateForModel(model);
  if (!rate) return null;
  const cost =
    (usage.inputTokens / 1_000_000) * rate.inputPerMtok +
    (usage.outputTokens / 1_000_000) * rate.outputPerMtok;
  return Math.round(cost * 1e6) / 1e6; // round to micro-dollars
}
