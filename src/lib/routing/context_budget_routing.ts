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
  settings: UserSettings,
): ModelTier {
  if (effectiveModel.provider === "compass") {
    if (effectiveModel.name === COMPASS_TIER_THINKING) return "thinking";
    if (effectiveModel.name === COMPASS_TIER_BALANCED) return "balanced";
    if (effectiveModel.name === COMPASS_TIER_FAST) return "fast";
    return "fast";
  }

  const providerId = settings.autoProviderId ?? null;
  const autoModelIds = settings.autoModelIds;
  if (
    providerId &&
    effectiveModel.provider === providerId &&
    Array.isArray(autoModelIds) &&
    autoModelIds.length > 0
  ) {
    const name = effectiveModel.name;
    if (name === autoModelIds[2]) return "thinking";
    if (name === autoModelIds[1]) return "balanced";
    if (name === autoModelIds[0]) return "fast";
  }

  return "balanced";
}

export function resolveTierLimitModelIds(
  settings: UserSettings,
  options?: {
    effectiveModel?: LargeLanguageModel;
    resolvedTier?: ModelTier;
  },
): {
  fast: string;
  balanced: string;
  thinking: string;
} {
  const ids = settings.autoModelIds ?? [];
  const providerId = settings.autoProviderId ?? "";
  let out: { fast: string; balanced: string; thinking: string };
  if (providerId === "openrouter" && ids.length > 0) {
    out = {
      fast: (ids[0] ?? "").trim(),
      balanced: (ids[1] ?? "").trim(),
      thinking: (ids[2] ?? "").trim(),
    };
  } else {
    out = {
      fast: getOpenRouterModelIdForCompassTier(COMPASS_TIER_FAST) ?? "",
      balanced: getOpenRouterModelIdForCompassTier(COMPASS_TIER_BALANCED) ?? "",
      thinking: getOpenRouterModelIdForCompassTier(COMPASS_TIER_THINKING) ?? "",
    };
  }
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
