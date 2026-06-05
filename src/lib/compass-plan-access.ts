/**
 * Subscription plan helpers for Atlarix Core.
 *
 * v11: plans no longer gate which Core models a user may select — every plan
 * gets all Core models, metered strictly by the shared Supabase token pool
 * (see `compass_usage.ts`). The old `filterCompassModelsForPlan` /
 * `coerceCompassModelForPlan` tier-gating was removed.
 */

export type AtlarixSubscriptionPlan = "free" | "pro" | "workforce";

export function subscriptionTierToPlan(tier: string | null | undefined): AtlarixSubscriptionPlan {
  const t = (tier ?? "free").toLowerCase();
  if (t === "pro") return "pro";
  if (t === "workforce") return "workforce";
  return "free";
}
