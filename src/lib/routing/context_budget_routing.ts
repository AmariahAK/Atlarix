import type { LargeLanguageModel, UserSettings } from "../schemas";
import type { ModelTier } from "./capability-registry";
import {
  COMPASS_TIER_BALANCED,
  COMPASS_TIER_FAST,
  COMPASS_TIER_THINKING,
  getOpenRouterModelIdForCompassTier,
} from "../../ipc/shared/compass_constants";

export function resolveContextBudgetTier(
  effectiveModel: LargeLanguageModel,
  _settings: UserSettings,
): ModelTier {
  if (effectiveModel.provider === "compass") {
    if (effectiveModel.name === COMPASS_TIER_THINKING) return "thinking";
    if (effectiveModel.name === COMPASS_TIER_BALANCED) return "balanced";
    if (effectiveModel.name === COMPASS_TIER_FAST) return "fast";
    return "fast";
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
    fast: getOpenRouterModelIdForCompassTier(COMPASS_TIER_FAST) ?? "",
    balanced: getOpenRouterModelIdForCompassTier(COMPASS_TIER_BALANCED) ?? "",
    thinking: getOpenRouterModelIdForCompassTier(COMPASS_TIER_THINKING) ?? "",
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
