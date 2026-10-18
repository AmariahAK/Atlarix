/** User-facing Atlarix Core copy (renderer-safe; model names from IPC catalog). */

export const ATLARIX_CORE_CATEGORY_LABEL = "Atlarix Core";

/**
 * Label for the subscription tier (users.plan / effective_tier from Supabase).
 * Billing is owned by Lemon Squeezy → Supabase; the app only displays this value.
 * Atlarix Core is pay-as-you-go (prepaid credit) on every plan, so this is display-only.
 */
export function formatCompassSubscriptionTier(
  tier: string | null | undefined,
): string {
  const t = (tier ?? "free").toLowerCase();
  if (t === "pro") return "Pro";
  return "Free";
}

/** Pre-v11 ids (`compass-*`) still count as Core tiers so old persisted selections render. */
const LEGACY_TIER_IDS = [
  "compass-fast",
  "compass-balanced",
  "compass-thinking",
];

export function isCompassTierId(tierId: string): boolean {
  return (
    CORE_TIER_ROWS.some((r) => r.id === tierId) ||
    LEGACY_TIER_IDS.includes(tierId)
  );
}

// The Atlarix Core models (up to five slots), shown individually in the picker. The real
// model name + provider (resolved from core-models.json) carries the meaning;
// no fast/balanced/thinking framing. `label` is only a fallback when no
// OpenRouter id resolves. Order = display order.
export const CORE_TIER_ROWS = [
  { id: "core-1", label: "Core 1", description: "" },
  { id: "core-2", label: "Core 2", description: "" },
  { id: "core-3", label: "Core 3", description: "" },
  { id: "core-4", label: "Core 4", description: "" },
  { id: "core-5", label: "Core 5", description: "" },
] as const;
