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

function openRouterRowSuggestsReasoning(
  row: OpenRouterModelRowExtended | undefined,
): boolean {
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
export function resolveReasoningCatalogModelId(
  effectiveModel: LargeLanguageModel,
): string {
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
    getCoreModelsDevTargetForTier(effectiveModel.name ?? "")?.providerId ??
    provider
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
    if (
      openRouterRowSuggestsReasoning(row) ||
      openRouterPrefixSuggestsReasoning(lower)
    ) {
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
 * Capability gate for the "Deep thinking" toggle: whether the given model can reason
 * at all. Superset of the native-provider check plus the gateway-thinking providers
 * (deepseek/qwen/minimax/google/vertex/auto). Does not need `builtinProviderId`, so
 * it can be answered from the model in settings alone.
 *
 * CALL THIS IN MAIN, NEVER IN THE RENDERER — despite containing no Node imports.
 * It reads two registries that are module-level state written only by main-process
 * code: the models.dev reasoning profiles (`models_dev.ts`) and the Core tier→vendor
 * routing map (`core-model-overrides.ts`). In a renderer both are permanently empty,
 * so this returned a provider-allowlist guess for every model — which is how the
 * whole Atlarix Core lineup ended up with no Deep-thinking toggle while the same
 * models on BYOK had one. The renderer reads `supportsDeepThinking`, stamped onto
 * each model by `getLanguageModelsByProviders`.
 */
export function isReasoningCapableModel(
  model: LargeLanguageModel | undefined | null,
): boolean {
  if (!model) return false;

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
  //
  // Asked of the VENDOR as well as the raw provider. Both lines below used to read
  // `model.provider` only, which for Atlarix Core is the synthetic `compass` — a name
  // no capability table has ever contained, and one `detectReasoningCapability` can
  // only answer for a slashed OpenRouter id (a direct-routed tier's id is bare). Every
  // direct-routed Core model therefore failed this fallback and the Deep-thinking
  // toggle was hidden for the whole lineup, while the same model on BYOK matched
  // `deepseek` here and showed it.
  //
  // Both are consulted rather than one replacing the other: the vendor answers "is
  // this model a reasoner", the raw provider answers "does this route carry reasoning"
  // — and a Core tier still routed through OpenRouter only satisfies the second. On a
  // catalog miss the permissive answer is the right one, per the convention above.
  if (PROVIDERS_THAT_SUPPORT_THINKING.includes(capabilityProvider)) return true;
  const offersAChannel = (providerId: string): boolean => {
    const cap = detectReasoningCapability(catalogModelId, providerId);
    return (
      cap.useOpenRouterReasoning ||
      cap.useGoogleThoughts ||
      cap.useOpenAiReasoningSummary
    );
  };
  return (
    offersAChannel(capabilityProvider) || offersAChannel(model.provider ?? "")
  );
}

/**
 * The provider id a DISPATCH should use for capability lookups.
 *
 * Dispatch keys off the wire provider (`modelClient.builtinProviderId`); capability
 * keys off the vendor actually serving the request. Those differ for exactly one
 * provider — Atlarix Core, whose wire id is the synthetic `compass` and whose vendor
 * comes from `core-models.json`. Everything else is identity.
 *
 * Deliberately requires BOTH arguments rather than reading the model alone: when a
 * turn falls back to Core for want of an API key (`fellBackToCore`), the wire id is
 * `compass` while `effectiveModel` still names the user's original selection, so
 * resolving from the model alone would look up a model that is not answering. In that
 * mismatch we keep `compass`, which resolves to no reasoning — the honest answer,
 * since we cannot know which tier took the turn from here.
 */
export function resolveDispatchCapabilityProviderId(
  effectiveModel: LargeLanguageModel,
  builtinProviderId: string | undefined,
): string | undefined {
  if (builtinProviderId !== "compass") return builtinProviderId;
  if (effectiveModel.provider !== "compass") return builtinProviderId;
  return resolveCapabilityProviderId(effectiveModel);
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
  const capabilityProviderId = resolveDispatchCapabilityProviderId(
    effectiveModel,
    builtinProviderId,
  );
  // Native budget-token providers (deepseek/qwen/minimax/google/vertex/auto).
  // Keyed on the VENDOR: a Core tier serving DeepSeek can exceed effort-"high" for
  // the same reason BYOK DeepSeek can — it is the same model — but under the wire
  // id `compass` it used to be told its ceiling was "high", so Deep ON asked for one
  // notch less than the model actually offers.
  if (
    capabilityProviderId &&
    PROVIDERS_THAT_SUPPORT_THINKING.includes(capabilityProviderId)
  ) {
    return "max";
  }
  // The WIRE provider here on purpose: this call classifies which request SHAPE the
  // route accepts (OpenRouter's reasoning object, Google's thinkingConfig, …), not
  // who serves the model.
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
  const capabilityProviderId = resolveDispatchCapabilityProviderId(
    effectiveModel,
    builtinProviderId,
  );
  const catalogModelId = resolveReasoningCatalogModelId(effectiveModel);
  // Wire provider: which native request shape (if any) this route accepts.
  const cap = detectReasoningCapability(catalogModelId, builtinProviderId);
  const reasoningPatch = buildReasoningProviderOptions(cap, true);
  if (Object.keys(reasoningPatch).length > 0) {
    return true;
  }
  // `modelId` is load-bearing: without it `getExtraProviderOptions` cannot consult the
  // model's own catalog profile and answers `unknown` for everything, which then falls
  // to a provider allowlist that has never contained `compass`. That is why Core turns
  // reported `reasoning=false` even for a model that declares an effort channel.
  const gateway = getExtraProviderOptions(
    capabilityProviderId,
    settings,
    true,
    undefined,
    catalogModelId,
  );
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
    // `reasoningEffort` was ABSENT here, so a direct (BYOK) OpenAI dispatch asked for a
    // summary and never stated an effort — the model's default applied and the Deep
    // toggle moved nothing on this route at all. Passing the resolved effort makes the
    // toggle mean something for BYOK too.
    patch.openai = {
      reasoningSummary: "auto",
      reasoningEffort: effort,
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
