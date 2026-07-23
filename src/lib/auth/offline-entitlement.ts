/**
 * Offline entitlement fallback.
 *
 * `getUserPlan` returns `'free'` on ANY error and the effective-tier cache is
 * in-memory only, so a paying user who launched without a network was silently
 * downgraded to Free for the whole session — workspace and automation limits
 * included. Failing safe is right; failing to the CHEAPEST state for someone who
 * paid is not.
 *
 * This is a fallback, never a cache-first path: the server value always wins
 * when the server answers. It is consulted only when the call failed.
 */

import type { UserSettings } from "@/lib/schemas";

export type UserPlanDb = "free" | "pro";

export type LastKnownEntitlement = NonNullable<
  UserSettings["lastKnownEntitlement"]
>;

/**
 * The plan to honour when the server is unreachable, or `null` to fall back to
 * `'free'` exactly as before.
 *
 * Rules, in order:
 *  - a record for a DIFFERENT user is not usable (shared machines / re-login)
 *  - no `subscriptionEndsAt` → not honourable. The absence of a boundary must
 *    never grant an unbounded entitlement; that's the failure you'd find months
 *    later, in the direction of giving away the product.
 *  - an unparseable date is treated the same way — refuse rather than guess.
 *  - past `subscriptionEndsAt` → the entitlement genuinely ended; `'free'`.
 */
export function resolveOfflineEntitlement(
  entitlement: LastKnownEntitlement | undefined,
  userId: string,
  now: number = Date.now(),
): { plan: UserPlanDb; effectiveTier: UserPlanDb } | null {
  if (!entitlement) return null;
  if (!userId || entitlement.userId !== userId) return null;

  const endsAt = entitlement.subscriptionEndsAt;
  if (!endsAt) return null;

  const endsMs = Date.parse(endsAt);
  if (Number.isNaN(endsMs)) return null;
  if (now >= endsMs) return null;

  return {
    plan: entitlement.plan,
    effectiveTier: entitlement.effectiveTier,
  };
}
