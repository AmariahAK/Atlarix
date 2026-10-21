/**
 * One read of the account's `users` row, shared by every reader (2026-10-17).
 * A signed-in launch read the same row ~8 times (the plan, the ban flag, the
 * subscription details, the onboarding flag, the plan snapshot, twice over),
 * measured in Supabase's edge logs.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const queries: Array<{ select: string; by: string; value: string }> = [];
let failCombined = false;
const ROW = {
  id: "u-1",
  email: "owner@example.test",
  plan: "pro",
  effective_tier: "pro",
  subscription_status: "active",
  subscription_ends_at: "2099-01-01T00:00:00Z",
  lemon_subscription_id: "sub_1",
  lemon_variant_id: "1226325",
  banned_at: null,
  onboarding_completed: true,
};

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    from: () => ({
      select: (select: string) => ({
        eq: (by: string, value: string) => {
          queries.push({ select, by, value });
          const combined = select.includes("onboarding_completed") && select.includes("banned_at");
          const result = combined && failCombined ? { data: null, error: { message: "column does not exist" } } : { data: ROW, error: null };
          return { maybeSingle: async () => result, single: async () => result };
        },
      }),
    }),
    auth: { onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }) },
  }),
}));
vi.mock("electron", () => ({ clipboard: {}, dialog: {}, shell: {}, app: { getPath: () => "/tmp" } }));
vi.mock("@/lib/auth/supabase-secure-storage", () => ({ createSecureSupabaseStorage: () => ({}), clearSupabaseSecureStorage: () => {} }));

process.env.SUPABASE_URL = "https://example.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY = "sb_publishable_test";

const client = await import("@/lib/auth/supabase-client");

beforeEach(() => {
  queries.length = 0;
  failCombined = false;
  client.__resetUserRowForTests();
  client.invalidatePlanCaches();
});

describe("the account row, read once", () => {
  it("the plan, ban flag, subscription details and onboarding flag share ONE query", async () => {
    await Promise.all([
      client.getUserPlan("u-1"),
      client.isUserBanned("u-1"),
      client.getOnboardingCompleted("u-1"),
    ]);
    await client.getSubscriptionDetails("owner@example.test");
    await client.isUserBanned("u-1");
    expect(queries).toHaveLength(1);
    expect(await client.getUserPlan("u-1")).toBe("pro");
    expect(await client.getOnboardingCompleted("u-1")).toBe(true);
    expect(await client.isUserBanned("u-1")).toBe(false);
  });

  it("a refresh after payment reads fresh, not from the shared copy", async () => {
    await client.getUserPlan("u-1");
    client.invalidatePlanCaches();
    await client.getUserPlan("u-1");
    expect(queries).toHaveLength(2);
  });

  it("the plan snapshot (focus / realtime) always asks the server", async () => {
    await client.getUserPlan("u-1");
    await client.fetchPlanSnapshot("owner@example.test");
    expect(queries).toHaveLength(2);
    // …and it refreshes the shared copy for the others.
    await client.isUserBanned("u-1");
    expect(queries).toHaveLength(2);
  });

  it("a launch: two session updates, each with its plan check, read the row ONCE", async () => {
    // Measured 2026-10-17: startup and Supabase's restored-session event each
    // ran the update, and each update's plan check forced a fresh read and then
    // dropped it: 4 reads per launch. This is that sequence.
    for (let i = 0; i < 2; i++) {
      await client.getUserPlan("u-1");
      await client.isUserBanned("u-1");
      await client.getSubscriptionDetails("owner@example.test");
      await client.fetchPlanSnapshot("owner@example.test", false);
      client.invalidatePlanCaches({ keepRow: true });
    }
    expect(queries).toHaveLength(1);
  });

  it("kept for as long as nothing changes it: an hour of readers is one read", async () => {
    // A 10 s TTL made every later reader a read of its own (owner, 2026-10-20:
    // 26 reads of this row in one 70-minute session). Sign-in, sign-out, the
    // focus refresh and writes are what refresh it now.
    vi.useFakeTimers();
    try {
      for (let minute = 0; minute < 60; minute++) {
        await client.getUserPlan("u-1");
        await client.isUserBanned("u-1");
        await client.getOnboardingCompleted("u-1");
        vi.advanceTimersByTime(60_000);
      }
    } finally {
      vi.useRealTimers();
    }
    expect(queries).toHaveLength(1);
  });

  it("if the combined read fails, each reader falls back to its own query: the plan is never lost", async () => {
    failCombined = true;
    expect(await client.getUserPlan("u-1")).toBe("pro");
    expect(await client.isUserBanned("u-1")).toBe(false);
    // The fallbacks ran (narrow selects), not just the failed combined one.
    expect(queries.some((q) => !q.select.includes("onboarding_completed"))).toBe(true);
  });
});
