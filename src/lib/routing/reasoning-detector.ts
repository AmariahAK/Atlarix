/**
 * Detect whether to enable provider-specific reasoning/thinking for the **thinking** context tier only.
 * Uses OpenRouter model metadata when the catalog cache is warm; otherwise vendor-prefix heuristics on the model id.
 */

import type { GoogleGenerativeAIProviderOptions } from "@ai-sdk/google";
import type { OpenAIResponsesProviderOptions } from "@ai-sdk/openai";
import {
  getCachedOpenRouterModelRow,
  type OpenRouterModelRowExtended,
} from "./tier-context-limits";
import { getOpenRouterModelIdForCoreTier } from "@/ipc/shared/compass_constants";
import type { LargeLanguageModel, UserSettings } from "@/lib/schemas";
import { getExtraProviderOptions } from "@/ipc/utils/thinking_utils";

/** OpenRouter / @openrouter/ai-sdk-provider reasoning block (effort OR max_tokens required). */
export type OpenRouterReasoningOpts = {
  enabled?: boolean;
  exclude?: boolean;
} & ({ max_tokens: number } | { effort: "high" | "medium" | "low" });

export type ReasoningProviderPatch = {
  openrouter?: Record<string, unknown>;
  google?: GoogleGenerativeAIProviderOptions;
  openai?: OpenAIResponsesProviderOptions;
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
 * Resolve the OpenRouter-style model id used for catalog lookup (Core tiers map to env model ids).
 */
export function resolveReasoningCatalogModelId(effectiveModel: LargeLanguageModel): string {
  const name = (effectiveModel.name ?? "").trim();
  if (effectiveModel.provider === "compass") {
    return getOpenRouterModelIdForCoreTier(name) ?? name;
  }
  return name;
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

  return {
    useOpenRouterReasoning,
    useGoogleThoughts,
    useOpenAiReasoningSummary,
  };
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
 * Build provider option fragments to merge into `streamText` `providerOptions` when thinking tier is active.
 * Caller merges shallowly into existing buckets (e.g. preserve openrouter.plugins).
 */
export function buildReasoningProviderOptions(
  cap: ReturnType<typeof detectReasoningCapability>,
  thinkingTier: boolean,
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
        effort: "medium",
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

  return patch;
}
