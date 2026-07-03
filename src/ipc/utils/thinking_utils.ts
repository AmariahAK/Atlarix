import { PROVIDERS_THAT_SUPPORT_THINKING } from "../shared/language_model_constants";
import type { UserSettings } from "../../lib/schemas";

/**
 * The reasoning effort applied to a request. The two user-visible levels (base
 * vs the `deepThinking` toggle) are CAPABILITY-DERIVED from each model's
 * reasoning ceiling, so the toggle is always meaningful and Deep always hits the
 * model's max:
 *  - Effort-ceiling providers (OpenAI, OpenRouter/compass — effort tops out at
 *    "high"): base = "medium", Deep = "high".
 *  - Budget-capable providers (DeepSeek/Qwen/MiniMax/Google/Vertex — can exceed
 *    effort-"high" via a token budget): base = "high", Deep = "max".
 * There is deliberately no user "low"; the only choice is the on/off toggle.
 */
export type ReasoningEffort = "medium" | "high" | "max";

/**
 * A model's reasoning ceiling by provider: budget-capable providers can go past
 * effort-"high" (to "max"); everything else tops out at "high".
 */
function reasoningCeiling(providerId: string | undefined): "high" | "max" {
  return providerId && PROVIDERS_THAT_SUPPORT_THINKING.includes(providerId)
    ? "max"
    : "high";
}

/** Resolve the effort: Deep = the ceiling, base = one notch below it. */
export function getReasoningEffort(
  settings: UserSettings | undefined,
  ceiling: "high" | "max",
): ReasoningEffort {
  const deep = !!settings?.deepThinking;
  if (ceiling === "max") return deep ? "max" : "high";
  return deep ? "high" : "medium";
}

/** Fallback max-output when the caller can't supply one (capability probes). */
const REASONING_MAXTOKENS_FALLBACK = 32_000;

/**
 * The reasoning token budget for a budget-channel model, SCALED to the model's
 * own catalog max output (fully automatic per-model, not a fixed number):
 *   high → ~50% of max, max → ~85% of max, medium → ~33%.
 * Always leaves an output reserve (≥15% of max, ≥2048 tokens) so reasoning can
 * never starve the visible answer — this IS the truncation guard (TODO #6).
 */
export function reasoningBudgetTokens(
  effort: ReasoningEffort,
  maxOutputTokens: number,
): number {
  const max = Math.max(1, Math.floor(maxOutputTokens));
  const reserve = Math.max(Math.round(max * 0.15), 2048);
  const ceil = Math.max(1024, max - reserve);
  const frac = effort === "max" ? 0.85 : effort === "high" ? 0.5 : 0.33;
  return Math.min(ceil, Math.max(1024, Math.round(max * frac)));
}

export function getExtraProviderOptions(
  providerId: string | undefined,
  settings: UserSettings,
  /** When false, omit extended thinking / reasoning-effort (fast & balanced tiers). */
  includeExtendedThinking = false,
  /** The resolved max output tokens for this model (for budget scaling). */
  maxOutputTokens?: number,
): Record<string, any> {
  if (!providerId) {
    return {};
  }
  if (!includeExtendedThinking) {
    return {};
  }
  // Ceiling for the channels THIS function handles: OpenAI is effort-only
  // ("high"); the thinking-budget providers are budget-capable ("max").
  const effort = getReasoningEffort(settings, reasoningCeiling(providerId));
  if (providerId === "openai") {
    // OpenAI's reasoning API is effort-only — "max" (never produced here, since
    // openai ceiling is "high") would clamp to "high".
    return {
      reasoning_effort: effort === "max" ? "high" : effort,
    };
  }
  if (PROVIDERS_THAT_SUPPORT_THINKING.includes(providerId)) {
    const budgetTokens = reasoningBudgetTokens(
      effort,
      maxOutputTokens ?? REASONING_MAXTOKENS_FALLBACK,
    );
    return {
      thinking: {
        type: "enabled",
        include_thoughts: true,
        budget_tokens: budgetTokens,
      },
    };
  }
  return {};
}
