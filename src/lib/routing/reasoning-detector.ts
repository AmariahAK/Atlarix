/**
 * Detect whether to enable provider-specific reasoning/thinking for the **thinking** context tier only.
 * Uses OpenRouter model metadata when the catalog cache is warm; otherwise vendor-prefix heuristics on the model id.
 */

import type { AnthropicProviderOptions } from "@ai-sdk/anthropic";
import type { GoogleGenerativeAIProviderOptions } from "@ai-sdk/google";
import type { OpenAIResponsesProviderOptions } from "@ai-sdk/openai";
import {
  getCachedOpenRouterModelRow,
  type OpenRouterModelRowExtended,
} from "./tier-context-limits";
import {
  getCoreModelIdForCoreTier,
  getCoreModelsDevTargetForTier,
} from "@/ipc/shared/compass_constants";
import { PROVIDERS_THAT_SUPPORT_THINKING } from "@/ipc/shared/language_model_constants";
import {
  catalogSaysReasons,
  hasMeaningfulReasoningControl,
} from "@/lib/routing/model-reasoning-profile";
import type { LargeLanguageModel, UserSettings } from "@/lib/schemas";
import {
  getExtraProviderOptions,
  reasoningBudgetTokens,
  type ReasoningEffort,
} from "@/ipc/utils/thinking_utils";

/** OpenRouter / @openrouter/ai-sdk-provider reasoning block (effort OR max_tokens required). */
export type OpenRouterReasoningOpts = {
  enabled?: boolean;
  exclude?: boolean;
} & ({ max_tokens: number } | { effort: "high" | "medium" | "low" });

export type ReasoningProviderPatch = {
  openrouter?: Record<string, unknown>;
  google?: GoogleGenerativeAIProviderOptions;
  openai?: OpenAIResponsesProviderOptions;
  /**
   * Anthropic's extended thinking. This bucket did not exist, which is why
   * direct (BYOK) Anthropic never actually requested reasoning: the thinking
   * block was only ever written into `providerOptions["dyad-gateway"]`, an
   * identifier no provider in this app declares, so it reached nothing. The
   * shape difference is the tell — that path emitted snake_case
   * `budget_tokens` / `include_thoughts` (a gateway wire format) where
   * `@ai-sdk/anthropic` reads camelCase `budgetTokens`.
   */
  anthropic?: AnthropicProviderOptions;
};

function openRouterRowSuggestsReasoning(row: OpenRouterModelRowExtended | undefined): boolean {
  if (!row) return false;
  const sp = row.supported_parameters;
  if (Array.isArray(sp)) {
    return sp.some((p) => String(p).toLowerCase().includes("reason"));
  }
  if (sp && typeof sp === "object") {
    return "reasoning" in sp || "include_reasoning" in sp;
  }
  return false;
}

/** Vendor slug prefixes on OpenRouter model ids that commonly expose reasoning APIs. */
function openRouterPrefixSuggestsReasoning(modelIdLower: string): boolean {
  return /^(openai|anthropic|x-ai|deepseek|qwen|google)\//.test(modelIdLower);
}

/**
 * Resolve the model id used for capability lookups.
 *
 * For Core this returns the VENDOR's own model id (e.g. `deepseek-v4-pro`), not the
 * `vendor/model` wire id. That matters beyond reasoning: this function also supplies
 * `modelApiId` to `buildToolModelOutput` (`ask-branch.ts`, `build-branch.ts`), which
 * feeds the vision / tool-media gates — and those resolve through a models.dev-backed
 * registry that keys on the bare id. Returning the slashed wire id left Core invisible
 * to all of them.
 */
export function resolveReasoningCatalogModelId(effectiveModel: LargeLanguageModel): string {
  const name = (effectiveModel.name ?? "").trim();
  if (effectiveModel.provider === "compass") {
    return (
      getCoreModelsDevTargetForTier(name)?.modelId ??
      getCoreModelIdForCoreTier(name) ??
      name
    );
  }
  return name;
}

/**
 * The Atlarix provider id actually backing a model — for Core, the vendor its tier
 * routes to (`deepseek`, `minimax`, …) rather than the synthetic `compass`.
 *
 * Capability lookups must key off the vendor: `compass` has no models.dev row, and
 * per-provider reasoning behaviour belongs to whoever serves the request.
 */
export function resolveCapabilityProviderId(
  effectiveModel: LargeLanguageModel,
): string {
  const provider = (effectiveModel.provider ?? "").trim();
  if (provider !== "compass") return provider;
  return (
    getCoreModelsDevTargetForTier(effectiveModel.name ?? "")?.providerId ?? provider
  );
}

/**
 * Whether extended reasoning should be requested for this model + gateway, when the user is on the thinking tier.
 */
export function detectReasoningCapability(
  modelApiId: string,
  builtinProviderId: string | undefined,
): {
  useOpenRouterReasoning: boolean;
  useGoogleThoughts: boolean;
  useOpenAiReasoningSummary: boolean;
  useAnthropicThinking: boolean;
} {
  const id = modelApiId.trim();
  const lower = id.toLowerCase();
  const pid = builtinProviderId ?? "";

  let useOpenRouterReasoning = false;
  if (pid === "openrouter" || pid === "compass") {
    const row = id.includes("/") ? getCachedOpenRouterModelRow(id) : undefined;
    if (openRouterRowSuggestsReasoning(row) || openRouterPrefixSuggestsReasoning(lower)) {
      useOpenRouterReasoning = true;
    }
  }

  let useGoogleThoughts = false;
  if (pid === "google") {
    useGoogleThoughts = true;
  }
  if (pid === "vertex") {
    const isPartnerModel = id.includes("/");
    const isGeminiModel = lower.startsWith("gemini");
    const isFlashLite = lower.includes("flash-lite");
    if (isGeminiModel && !isFlashLite && !isPartnerModel) {
      useGoogleThoughts = true;
    }
  }

  const useOpenAiReasoningSummary = pid === "openai";

  // Direct (BYOK) Anthropic. Catalog-driven rather than a Claude model list, so a
  // new model needs no code change — and `undefined` (a model newer than the last
  // models.dev refresh) deliberately reads as FALSE here: `anthropic` is not in
  // PROVIDERS_THAT_SUPPORT_THINKING, so there is no legacy fallback, and sending
  // a thinking block Anthropic does not accept is a hard 400. No thinking is the
  // safe answer for an unknown model.
  const useAnthropicThinking =
    pid === "anthropic" && catalogSaysReasons(pid, id) === true;

  return {
    useOpenRouterReasoning,
    useGoogleThoughts,
    useOpenAiReasoningSummary,
    useAnthropicThinking,
  };
}

/**
 * Renderer-safe capability gate for the "Deep thinking" toggle: whether the given
 * model can reason at all. Superset of the native-provider check plus the
 * gateway-thinking providers (deepseek/qwen/minimax/google/vertex/auto). Does not
 * need `builtinProviderId`, so the UI can call it from the model in settings.
 */
export function isReasoningCapableModel(
  model: LargeLanguageModel | undefined | null,
): boolean {
  if (!model) return false;
  const provider = model.provider ?? "";

  // Per-model catalog answer wins where we have one: a provider allowlist showed the
  // toggle for every model of a "thinking" provider, including ones that don't reason
  // (deepseek-chat) or that expose no control to toggle (MiniMax-M2.7).
  const capabilityProvider = resolveCapabilityProviderId(model);
  const catalogModelId = resolveReasoningCatalogModelId(model);
  const saysReasons = catalogSaysReasons(capabilityProvider, catalogModelId);
  if (saysReasons === false) return false;
  if (saysReasons === true) {
    return hasMeaningfulReasoningControl(capabilityProvider, catalogModelId);
  }

  // Catalog miss → legacy behaviour, so a newly released model isn't hidden.
  if (PROVIDERS_THAT_SUPPORT_THINKING.includes(provider)) return true;
  const cap = detectReasoningCapability(catalogModelId, provider);
  return (
    cap.useOpenRouterReasoning ||
    cap.useGoogleThoughts ||
    cap.useOpenAiReasoningSummary
  );
}

/**
 * A model's reasoning CEILING, derived from its catalog-declared channel (not a
 * per-model hardcode): a channel that accepts a token BUDGET can exceed
 * effort-"high" → "max"; a pure EFFORT channel (OpenAI reasoning_effort) tops out
 * at "high". Used to pick the base/deep effort pair (getReasoningEffort).
 */
export function deriveReasoningCeiling(
  effectiveModel: LargeLanguageModel,
  builtinProviderId: string | undefined,
): "high" | "max" {
  // Native budget-token providers (deepseek/qwen/minimax/google/vertex/auto).
  if (builtinProviderId && PROVIDERS_THAT_SUPPORT_THINKING.includes(builtinProviderId)) {
    return "max";
  }
  const cap = detectReasoningCapability(
    resolveReasoningCatalogModelId(effectiveModel),
    builtinProviderId,
  );
  // Budget channels (OpenRouter reasoning.max_tokens, Google thinkingBudget).
  if (cap.useOpenRouterReasoning || cap.useGoogleThoughts) return "max";
  // Pure effort channel (OpenAI) or no special reasoning channel.
  return "high";
}

/**
 * Whether the effective model + gateway can request native extended thinking/reasoning
 * (provider options + gateway thinking flags used on the thinking tier).
 */
export function hasNativeDeepThinkingSupport(
  effectiveModel: LargeLanguageModel,
  builtinProviderId: string | undefined,
  settings: UserSettings,
): boolean {
  const catalogModelId = resolveReasoningCatalogModelId(effectiveModel);
  const cap = detectReasoningCapability(catalogModelId, builtinProviderId);
  const reasoningPatch = buildReasoningProviderOptions(cap, true);
  if (Object.keys(reasoningPatch).length > 0) {
    return true;
  }
  const gateway = getExtraProviderOptions(builtinProviderId, settings, true);
  return Object.keys(gateway).length > 0;
}

/**
 * Must `temperature` be omitted from this dispatch?
 *
 * Anthropic rejects `temperature != 1` while extended thinking is enabled, and
 * `getTemperature` defaults to 0 — so requesting thinking without dropping
 * temperature is a hard 400 on every BYOK Anthropic reasoning turn. Exported and
 * tested because it is a cross-cutting coupling between two unrelated call sites
 * (the reasoning patch and the temperature lookup) and would regress silently:
 * nothing fails locally, every real Anthropic reasoning request fails.
 *
 * Omitting rather than forcing 1 is deliberate — it lets Anthropic apply its own
 * thinking default instead of us asserting a value we only picked to satisfy a
 * constraint.
 */
export function shouldOmitTemperature(
  providerOptions: Record<string, unknown> | undefined,
): boolean {
  const anthropic = providerOptions?.anthropic as
    | { thinking?: unknown }
    | undefined;
  return Boolean(anthropic?.thinking);
}

/**
 * Build provider option fragments to merge into `streamText` `providerOptions` when thinking tier is active.
 * Caller merges shallowly into existing buckets (e.g. preserve openrouter.plugins).
 */
export function buildReasoningProviderOptions(
  cap: ReturnType<typeof detectReasoningCapability>,
  thinkingTier: boolean,
  effort: ReasoningEffort = "medium",
  /** Resolved max output tokens — scales the OpenRouter reasoning budget. */
  maxOutputTokens?: number,
): ReasoningProviderPatch {
  if (!thinkingTier) {
    return {};
  }
  const patch: ReasoningProviderPatch = {};

  if (cap.useOpenRouterReasoning) {
    patch.openrouter = {
      /** OpenRouter: stream `reasoning_details` / reasoning deltas (needed for many models, including Compass). */
      include_reasoning: true,
      reasoning: {
        enabled: true,
        // Budget encoding scaled to the model's own max output (reserves output
        // headroom so reasoning can't truncate the answer). OpenRouter maps
        // reasoning.max_tokens across its reasoning models; this makes base<deep
        // real on the primary gateway rather than clamping to effort-"high".
        max_tokens: reasoningBudgetTokens(effort, maxOutputTokens ?? 32_000),
      } satisfies OpenRouterReasoningOpts,
    };
  }

  if (cap.useGoogleThoughts) {
    patch.google = {
      thinkingConfig: {
        includeThoughts: true,
      },
    } satisfies GoogleGenerativeAIProviderOptions;
  }

  if (cap.useOpenAiReasoningSummary) {
    patch.openai = {
      reasoningSummary: "auto",
    } satisfies OpenAIResponsesProviderOptions;
  }

  if (cap.useAnthropicThinking) {
    // Anthropic takes a token BUDGET, not an effort level. `reasoningBudgetTokens`
    // already guarantees >= 1024 (Anthropic's minimum) and reserves >= 2048 of
    // output headroom, so the budget is always strictly below max_tokens — which
    // Anthropic also requires.
    patch.anthropic = {
      thinking: {
        type: "enabled",
        budgetTokens: reasoningBudgetTokens(effort, maxOutputTokens ?? 32_000),
      },
    } satisfies AnthropicProviderOptions;
  }

  return patch;
}
