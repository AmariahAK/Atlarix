import type { LargeLanguageModel, UserSettings } from "../schemas";
import type { ModelTier } from "./capability-registry";
import {
  CORE_TIER_1,
  CORE_TIER_2,
  CORE_TIER_3,
  CORE_TIER_4,
  getOpenRouterModelIdForCoreTier,
  normalizeCoreTierId,
} from "../../ipc/shared/compass_constants";

export function resolveContextBudgetTier(
  effectiveModel: LargeLanguageModel,
  _settings: UserSettings,
): ModelTier {
  if (effectiveModel.provider === "compass") {
    switch (normalizeCoreTierId(effectiveModel.name)) {
      case CORE_TIER_4:
      case CORE_TIER_3:
        return "thinking";
      case CORE_TIER_2:
        return "balanced";
      case CORE_TIER_1:
      default:
        return "fast";
    }
  }

  return "balanced";
}

export function resolveTierLimitModelIds(
  _settings: UserSettings,
  options?: {
    effectiveModel?: LargeLanguageModel;
    resolvedTier?: ModelTier;
  },
): {
  fast: string;
  balanced: string;
  thinking: string;
} {
  let out: { fast: string; balanced: string; thinking: string } = {
    fast: getOpenRouterModelIdForCoreTier(CORE_TIER_1) ?? "",
    balanced: getOpenRouterModelIdForCoreTier(CORE_TIER_2) ?? "",
    thinking: getOpenRouterModelIdForCoreTier(CORE_TIER_3) ?? "",
  };
  const em = options?.effectiveModel;
  const rt = options?.resolvedTier;
  if (em?.provider === "openrouter" && em.name?.trim() && rt) {
    const name = em.name.trim();
    out = { ...out, [rt]: name };
  }
  return out;
}

export function needsOpenRouterContextSafety(
  builtinProviderId: string | undefined,
  tier: ModelTier,
): boolean {
  if (tier === "fast") return false;
  if (tier !== "balanced" && tier !== "thinking") return false;
  return builtinProviderId === "compass" || builtinProviderId === "openrouter";
}
