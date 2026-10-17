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

  it("if the combined read fails, each reader falls back to its own query: the plan is never lost", async () => {
    failCombined = true;
    expect(await client.getUserPlan("u-1")).toBe("pro");
    expect(await client.isUserBanned("u-1")).toBe(false);
    // The fallbacks ran (narrow selects), not just the failed combined one.
    expect(queries.some((q) => !q.select.includes("onboarding_completed"))).toBe(true);
  });
});
