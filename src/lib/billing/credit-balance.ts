/**
 * The signed-in account's Atlarix balance, read once for everyone asking at the
 * same moment. Each `relic` call asks (free/BYOK hosting depends on it), and so
 * do /status and /plans: four parallel relic calls were four identical RPCs in
 * under a second (Supabase logs, 2026-10-05). Concurrent callers share one
 * request; a result is reused for `maxAgeMs`.
 */
import { getSession, getSupabaseClient } from "@/lib/auth/supabase-client";

let cached: { at: number; cents: number | null } | null = null;
let inFlight: Promise<number | null> | null = null;

/** Balance in cents; null when signed out or unreadable. */
export async function creditBalanceCents(maxAgeMs = 30_000): Promise<number | null> {
  if (cached && Date.now() - cached.at <= maxAgeMs) return cached.cents;
  inFlight ??= (async () => {
    try {
      if (!(await getSession().catch(() => null))) return null;
      const { data, error } = await getSupabaseClient().rpc("get_credit_balance");
      if (error) return null;
      const cents = (data as { balance_cents?: number } | null)?.balance_cents;
      const value = typeof cents === "number" ? cents : null;
      cached = { at: Date.now(), cents: value };
      return value;
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}
