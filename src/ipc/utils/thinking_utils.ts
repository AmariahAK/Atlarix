import { PROVIDERS_THAT_SUPPORT_THINKING } from "../shared/language_model_constants";
import {
  chosenLevel,
  effortChoicesFor,
  resolveReasoningRequest,
  type EffortChoices,
} from "../../lib/routing/model-reasoning-profile";
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
export type ReasoningEffort = "medium" | "high" | "xhigh" | "max";

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

/**
 * The effort for OpenAI's effort-only reasoning API.
 *
 * SEPARATE FROM `getReasoningEffort` ON PURPOSE. That function pairs a base with a
 * ceiling, and its ceiling-"max" base is "high" because the providers that reach "max"
 * are BUDGET-channel ones that are also cheap. OpenAI reaching "max" through the same
 * function would therefore have raised its BASE to "high" — a bill increase for every
 * user who never touched the toggle, which is not a change to make quietly.
 *
 * The accepted set is `none/low/medium/high/xhigh/max`, verbatim from the API's own 400
 * on `minimal`, and `@ai-sdk/openai` types it identically. Previously this route asked
 * for "high" at most and additionally mapped "max" -> "high", so the top TWO levels were
 * unreachable on models we already pay to have access to.
 *
 *  - Deep OFF stays **medium**: unchanged cost, unchanged default behaviour.
 *  - Deep ON goes to **max**, because "Deep = the ceiling" is what the toggle means
 *    everywhere else, and "high" was two notches short of this API's ceiling.
 */
export function openAiReasoningEffort(
  settings: UserSettings | undefined,
): ReasoningEffort {
  return settings?.deepThinking ? "max" : "medium";
}

/**
 * The level chosen with /effort for this dispatch, when this model lists it.
 * Null means nothing was chosen (or the choice was another model's): every route
 * then behaves exactly as it did before /effort.
 *
 * The deep-thinking switch with no level (`atlarix run --deep-thinking`, or
 * settings from before /effort) is the top of a NAMED list: adaptive Claude
 * otherwise got no effort at all and ran at the API's default. Budget and toggle
 * models keep their own deep-thinking path.
 */
export function chosenEffortFor(
  settings: UserSettings | undefined,
  providerId: string | undefined,
  modelId: string | undefined,
): { level: string; choices: EffortChoices } | null {
  const want = settings?.effort?.trim();
  if (!modelId || (!want && !settings?.deepThinking)) return null;
  const choices = effortChoicesFor(providerId, modelId);
  if (!choices) return null;
  if (!want) return choices.kind === "effort" ? { level: chosenLevel(choices, undefined, true), choices } : null;
  if (!choices.levels.some((l) => l.toLowerCase() === want.toLowerCase())) return null;
  return { level: chosenLevel(choices, want), choices };
}

/** Fallback max-output when the caller can't supply one (capability probes). */
const REASONING_MAXTOKENS_FALLBACK = 32_000;

/**
 * The reasoning token budget for a budget-channel model, SCALED to the model's
 * own catalog max output (fully automatic per-model, not a fixed number):
 *   low → ~15% of max (only a budget model's /effort low asks for it),
 *   medium → ~33%, high → ~50%, xhigh → ~70%, max → ~85%.
 * Always leaves an output reserve (≥15% of max, ≥2048 tokens) so reasoning can
 * never starve the visible answer — this IS the truncation guard (TODO #6).
 */
export function reasoningBudgetTokens(
  effort: ReasoningEffort | "low",
  maxOutputTokens: number,
): number {
  const max = Math.max(1, Math.floor(maxOutputTokens));
  const reserve = Math.max(Math.round(max * 0.15), 2048);
  const ceil = Math.max(1024, max - reserve);
  // EVERY member of ReasoningEffort gets a fraction. `xhigh` was added to the type for
  // OpenAI's effort-only API, which does not use this function at all — but leaving it
  // to fall through to the final `: 0.33` would have quietly given it the MEDIUM budget
  // the first time a budget-channel model was handed it. Sits between high and max.
  const frac =
    effort === "max"
      ? 0.85
      : effort === "xhigh"
        ? 0.7
        : effort === "high"
          ? 0.5
          : effort === "low"
            ? 0.15
            : 0.33;
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
    // A chosen level goes out exactly as the model lists it (`xhigh` stays `xhigh`).
    const chosen = chosenEffortFor(settings, providerId, modelId);
    return {
      reasoningEffort:
        chosen?.choices.kind === "effort" ? chosen.level : openAiReasoningEffort(settings),
    };
  }

  const deepThinking = !!settings?.deepThinking;
  const resolved = modelId
    ? resolveReasoningRequest({ providerId, modelId, deepThinking, effort: settings?.effort })
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
