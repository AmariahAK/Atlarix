/** User-facing Compass tier copy (renderer-safe; no IPC / env). */

/**
 * Label for the subscription tier returned by Supabase (`get_compass_usage_state` / `users.plan`·`effective_tier`).
 * Billing is owned by Lemon Squeezy → Supabase; the app only displays this value.
 */
export function formatCompassSubscriptionTier(
  tier: string | null | undefined,
): string {
  const t = (tier ?? "free").toLowerCase();
  if (t === "workforce") return "Workforce";
  if (t === "pro") return "Pro";
  return "Free";
}

export const COMPASS_TIER_ROWS = [
  {
    id: "compass-fast",
    title: "Compass Fast",
    description: "Quick responses for simple tasks and Ask mode",
  },
  {
    id: "compass-balanced",
    title: "Compass Balanced",
    description: "Strong all-rounder for planning and building",
  },
  {
    id: "compass-thinking",
    title: "Compass Thinking",
    description: "Deep reasoning for complex debugging and architecture work",
  },
] as const;
