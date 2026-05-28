/** User-facing Atlarix Core copy (renderer-safe; model names from IPC catalog). */

export const ATLARIX_CORE_CATEGORY_LABEL = "Atlarix Core";

/**
 * Label for the subscription tier returned by Supabase (`get_compass_usage_state` / `users.plan`·`effective_tier`).
 * Billing is owned by Lemon Squeezy → Supabase; the app only displays this value.
 */
export function formatCompassSubscriptionTier(
  tier: string | null | undefined,
): string {
  const t = (tier ?? "free").toLowerCase();
  if (t === "workforce") return "Team";
  if (t === "pro") return "Studio";
  return "Solo";
}

export function isCompassTierId(tierId: string): boolean {
  return COMPASS_TIER_ROWS.some((r) => r.id === tierId);
}

export const COMPASS_TIER_ROWS = [
  {
    id: "compass-fast",
    description: "Included with Solo — general coding and exploration",
  },
  {
    id: "compass-balanced",
    description: "Studio and Team — stronger all-rounder for planning and building",
  },
  {
    id: "compass-thinking",
    description: "Studio and Team — deeper reasoning for complex work",
  },
] as const;
