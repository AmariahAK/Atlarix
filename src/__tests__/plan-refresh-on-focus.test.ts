/**
 * The plan refresh that replaced the realtime channel.
 *
 * WHY THE CHANNEL WENT. An always-open Supabase realtime subscription on `users`, one
 * per signed-in app, made `realtime.list_changes` 93.5% of this project's total database
 * execution time — 7.3M WAL polls, measured 2026-08-27 — to deliver an event most
 * accounts never fire.
 *
 * WHY FOCUS IS A BETTER FIT, not just a cheaper one. A plan change happens in a BROWSER,
 * so the user necessarily leaves the app and comes back. The old focus handler sat behind
 * a 60-second idle-out, so the actual upgrade flow — pay, alt-tab straight back — hit
 * NEITHER path and refreshed nothing.
 *
 * Two properties are load-bearing and both are asserted here: it must throttle (focus
 * fires on every window switch) and it must not broadcast when nothing changed (~22
 * unshared useAuth consumers re-render on every broadcast).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

let snapshot: unknown = null;
const fetchPlanSnapshot = vi.fn(async () => snapshot);
const invalidatePlanCaches = vi.fn();

vi.mock("@/lib/auth/supabase-client", () => ({
  fetchPlanSnapshot: (...a: unknown[]) => fetchPlanSnapshot(...(a as [])),
  invalidatePlanCaches: () => invalidatePlanCaches(),
  subscribeToPlanChanges: () => () => {},
  getSupabaseClient: () => ({}),
}));

async function freshManager(session: Record<string, unknown> | null) {
  vi.resetModules();
  const mod = await import("@/lib/SubscriptionManager");
  const SM = mod.SubscriptionManager as unknown as Record<string, unknown>;
  (SM as { session: unknown }).session = session;
  return SM as unknown as {
    refreshPlanFromServer(ms?: number): Promise<void>;
    broadcastPlanChanged: unknown;
  };
}

const SESSION = { email: "a@b.c", plan: "free", effectiveTier: "free", banned: false };

describe("refreshPlanFromServer", () => {
  beforeEach(() => {
    fetchPlanSnapshot.mockClear();
    invalidatePlanCaches.mockClear();
    snapshot = null;
  });

  it("does nothing without a signed-in session", async () => {
    const SM = await freshManager(null);
    await SM.refreshPlanFromServer(0);

    // No email means no row to read. Firing anyway would query on every focus of a
    // signed-out app, which is the opposite of the point.
    expect(fetchPlanSnapshot).not.toHaveBeenCalled();
  });

  it("throttles: a second focus inside the window does not re-read", async () => {
    snapshot = { plan: "free", effectiveTier: "free", banned: false };
    const SM = await freshManager({ ...SESSION });

    await SM.refreshPlanFromServer(0);
    await SM.refreshPlanFromServer(60_000);

    // Focus fires on every window switch; without this the "cheaper than realtime"
    // claim stops being true for anyone who alt-tabs.
    expect(fetchPlanSnapshot).toHaveBeenCalledTimes(1);
  });

  it("drops the cached tier even when the plan is unchanged", async () => {
    snapshot = { plan: "free", effectiveTier: "free", banned: false };
    const SM = await freshManager({ ...SESSION });

    await SM.refreshPlanFromServer(0);

    // "Unchanged" is measured against the SESSION, and the 30-minute tier cache can
    // be stale for reasons the session does not track.
    expect(invalidatePlanCaches).toHaveBeenCalled();
  });

  it("survives a failed read without throwing", async () => {
    fetchPlanSnapshot.mockRejectedValueOnce(new Error("offline"));
    const SM = await freshManager({ ...SESSION });

    // Runs on window focus. Throwing there is not an option.
    await expect(SM.refreshPlanFromServer(0)).resolves.toBeUndefined();
  });
});
