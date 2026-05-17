/** User-facing Model Bridge tier copy (renderer-safe; no IPC / env). */

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

export const COMPASS_TIER_ROWS = [
  {
    id: "compass-fast",
    title: "Speed",
    description: "Quick responses for simple tasks and Explore mode",
  },
  {
    id: "compass-balanced",
    title: "Standard",
    description: "Strong all-rounder for planning and building",
  },
  {
    id: "compass-thinking",
    title: "Deep",
    description: "Deep reasoning for complex debugging and architecture work",
  },
] as const;
