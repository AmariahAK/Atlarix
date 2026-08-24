import { PROVIDERS_THAT_SUPPORT_THINKING } from "../shared/language_model_constants";
import { resolveReasoningRequest } from "../../lib/routing/model-reasoning-profile";
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

/**
 * Reasoning parameters for a dispatch.
 *
 * `modelId` drives a models.dev lookup so the KIND of control matches what the model
 * declares. The old behaviour keyed only off `providerId` and sent every model of a
 * listed provider the same Anthropic/Google-shaped `thinking.budget_tokens` block —
 * which MiniMax-M3 (a toggle-only model) has no use for, so its reasoning was never
 * really being controlled. A catalog miss falls back to that legacy behaviour rather
 * than dropping reasoning for a model newer than the last refresh.
 */
export function getExtraProviderOptions(
  providerId: string | undefined,
  settings: UserSettings,
  /** When false, omit extended thinking / reasoning-effort (fast & balanced tiers). */
  includeExtendedThinking = false,
  /** The resolved max output tokens for this model (for budget scaling). */
  maxOutputTokens?: number,
  /** The model's own api id — enables the per-model catalog resolution. */
  modelId?: string,
): Record<string, any> {
  if (!providerId) {
    return {};
  }
  if (!includeExtendedThinking) {
    return {};
  }

  if (providerId === "openai") {
    // OpenAI's reasoning API is effort-only.
    const effort = getReasoningEffort(settings, "high");
    return { reasoningEffort: effort === "max" ? "high" : effort };
  }

  const deepThinking = !!settings?.deepThinking;
  const resolved = modelId
    ? resolveReasoningRequest({ providerId, modelId, deepThinking })
    : ({ kind: "unknown" } as const);

  switch (resolved.kind) {
    case "none":
      // Declares no control, or does not reason. Sending a parameter can only hurt.
      return {};
    case "toggle":
      // Two-state only — never a level. This is the MiniMax-M3 case.
      return { thinking: { type: resolved.enabled ? "enabled" : "disabled" } };
    case "effort":
      // Guaranteed to be a value the model listed.
      //
      // camelCase ON PURPOSE — this is not a wire field, it is the
      // `@ai-sdk/openai-compatible` provider option, and the SDK maps it to the
      // request body's `reasoning_effort`. Sending snake_case here looks right and
      // silently does nothing: the SDK spreads the provider bucket into the body and
      // THEN writes `reasoning_effort: compatibleOptions.reasoningEffort ?? undefined`
      // over the top, so a snake_case key we supplied is overwritten with `undefined`
      // and dropped entirely by JSON.stringify. See the body assembly in
      // @ai-sdk/openai-compatible's `getArgs`.
      return { reasoningEffort: resolved.effort };
    case "budget":
      return {
        thinking: {
          type: "enabled",
          include_thoughts: true,
          budget_tokens: reasoningBudgetTokens(
            resolved.effortHint,
            maxOutputTokens ?? REASONING_MAXTOKENS_FALLBACK,
          ),
        },
      };
    case "unknown":
    default:
      break;
  }

  // Catalog miss → legacy provider-level behaviour, so a brand-new model is not
  // silently downgraded to non-reasoning.
  if (PROVIDERS_THAT_SUPPORT_THINKING.includes(providerId)) {
    const effort = getReasoningEffort(settings, reasoningCeiling(providerId));
    return {
      thinking: {
        type: "enabled",
        include_thoughts: true,
        budget_tokens: reasoningBudgetTokens(
          effort,
          maxOutputTokens ?? REASONING_MAXTOKENS_FALLBACK,
        ),
      },
    };
  }
  return {};
}
