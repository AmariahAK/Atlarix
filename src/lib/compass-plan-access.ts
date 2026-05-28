import type { LanguageModel } from "@/ipc/ipc_types";
import {
  COMPASS_TIER_BALANCED,
  COMPASS_TIER_FAST,
  COMPASS_TIER_THINKING,
  coerceCompassTierForPlan,
  type CompassPlan,
} from "@/ipc/shared/compass_constants";

export type AtlarixSubscriptionPlan = "free" | "pro" | "workforce";

export function subscriptionTierToPlan(tier: string | null | undefined): AtlarixSubscriptionPlan {
  const t = (tier ?? "free").toLowerCase();
  if (t === "pro") return "pro";
  if (t === "workforce") return "workforce";
  return "free";
}

/** Solo: one Core model (fast env slot). Studio / Team: all configured Core models. */
export function filterCompassModelsForPlan(
  models: LanguageModel[],
  plan: AtlarixSubscriptionPlan,
): LanguageModel[] {
  if (plan === "free") {
    return models.filter((m) => m.apiName === COMPASS_TIER_FAST);
  }
  return models.filter((m) =>
    (
      [COMPASS_TIER_FAST, COMPASS_TIER_BALANCED, COMPASS_TIER_THINKING] as string[]
    ).includes(m.apiName),
  );
}

/** Downgrade disallowed internal tier ids for Solo before send. */
export function coerceCompassModelForPlan(
  internalTierId: string,
  plan: AtlarixSubscriptionPlan,
): string {
  return coerceCompassTierForPlan(internalTierId, plan as CompassPlan);
}
