/**
 * The Usage page's Credits tab: the signed-in account's Atlarix spend per local
 * day (Auto paid and Core apart), the balance left, and for Pro the allowance
 * and its reset date. Atlarix credits only; a BYOK turn costs the account
 * nothing and is never here.
 *
 * One `get_usage_credits` RPC, as the account itself (own rows only). Shared by
 * concurrent callers and reused for a minute, like credit-balance.
 */
import { getSession, getSupabaseClient } from "@/lib/auth/supabase-client";

export type { UsageCredits, UsageCreditsDay } from "@/lib/stats/usage-types";
import type { UsageCredits } from "@/lib/stats/usage-types";

const cents = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.round(v)) : 0);

/** The RPC's body as the tab reads it; anything malformed is "unavailable", never zeros. */
export function parseUsageCredits(data: unknown): UsageCredits {
  const d = data as Record<string, unknown> | null;
  if (!d || d.ok !== true || typeof d.balance_cents !== "number") return { state: "unavailable" };
  const days = Array.isArray(d.days) ? d.days : [];
  return {
    state: "ok",
    balanceCents: Math.round(d.balance_cents),
    purchasedCents: cents(d.purchased_cents),
    grantedCents: cents(d.granted_cents),
    grantedTotalCents: cents(d.granted_total_cents),
    plan: d.plan === "pro" ? "pro" : "free",
    renewsAt: typeof d.renews_at === "string" && d.renews_at ? d.renews_at : null,
    since: typeof d.since === "string" && d.since ? d.since : null,
    days: days
      .filter((x): x is Record<string, unknown> => !!x && typeof x === "object" && typeof (x as { day?: unknown }).day === "string")
      .map((x) => ({
        day: String(x.day),
        autoPaidCents: cents(x.auto_paid_cents),
        coreCents: cents(x.core_cents),
        toolCents: cents(x.tool_cents),
        otherCents: cents(x.other_cents),
        unsplitCents: cents(x.unsplit_cents),
      }))
      .sort((a, b) => a.day.localeCompare(b.day)),
  };
}

/** This computer's IANA zone, so the server buckets spend into the user's own days. */
export function localTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

let cached: { at: number; days: number; value: UsageCredits } | null = null;
let inFlight: Promise<UsageCredits> | null = null;

export async function getUsageCredits(days = 365, maxAgeMs = 60_000): Promise<UsageCredits> {
  if (cached && cached.days === days && Date.now() - cached.at <= maxAgeMs) return cached.value;
  inFlight ??= (async () => {
    try {
      if (!(await getSession().catch(() => null))) return { state: "signed_out" } as const;
      const { data, error } = await getSupabaseClient().rpc("get_usage_credits", {
        p_days: days,
        p_tz: localTimeZone(),
      });
      const value: UsageCredits = error ? { state: "unavailable" } : parseUsageCredits(data);
      cached = { at: Date.now(), days, value };
      return value;
    } catch {
      return { state: "unavailable" } as const;
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}
