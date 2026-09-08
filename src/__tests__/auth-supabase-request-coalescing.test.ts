/**
 * `useAuth` is a plain hook with no shared state and ~20 consumers, so each one runs
 * its own `checkSession()` on mount, and every consumer independently fires the
 * Supabase-backed reads.
 *
 * The duplication was found through a WRITE: `auth:claim-signup-credit` showed four
 * `claim_signup_credit` calls inside a single second, for a grant that could only ever
 * happen once. That channel went away with the $1 signup trial on 2026-09-08; the reads
 * it travelled alongside did not, and neither did the fan-out.
 *
 * These assert the property that fixes it: overlapping reads share one upstream call,
 * and nothing is cached past settlement, so a balance right after a top-up is fresh.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { rpc, getSubscriptionDetails } = vi.hoisted(() => ({
  rpc: vi.fn(),
  getSubscriptionDetails: vi.fn(async () => ({ status: "active", endsAt: null })),
}));

vi.mock("@/lib/auth/supabase-client", () => ({
  getSupabaseClient: () => ({ rpc }),
  getSubscriptionDetails,
  getOnboardingCompleted: () => true,
  setOnboardingCompleted: () => {},
}));

vi.mock("@/lib/SubscriptionManager", () => ({
  SubscriptionManager: {
    getCurrentUser: () => ({ email: "owner@example.com", id: "u1" }),
    isLoggedIn: () => true,
    isPro: () => false,
    getEffectiveTier: () => "pro",
    getWorkspaceCount: async () => 0,
    getCurrentWorkspaceDetails: async () => null,
    signOut: async () => {},
  },
}));

vi.mock("@/db", () => ({
  db: { select: () => ({ from: () => ({ all: () => [] }) }) },
}));
vi.mock("@/db/schema", () => ({ apps: {}, chatSessions: {} }));

import { ipcMain } from "electron";
import { registerAuthHandlers } from "@/ipc/handlers/auth_handlers";

type Handler = (event: unknown, payload?: unknown) => Promise<unknown>;

function latestHandler(channel: string): Handler {
  const calls = (ipcMain.handle as unknown as { mock: { calls: unknown[][] } }).mock
    .calls;
  const found = [...calls].reverse().find((c) => c[0] === channel);
  if (!found) throw new Error(`no handler registered for ${channel}`);
  return found[1] as Handler;
}

/** Resolves only after `release()` is called, so calls can be forced to overlap. */
function deferred<T>() {
  let release!: (v: T) => void;
  const promise = new Promise<T>((res) => {
    release = res;
  });
  return { promise, release };
}

describe("auth IPC coalescing — one Supabase call per burst", () => {
  beforeEach(async () => {
    rpc.mockReset();
    getSubscriptionDetails.mockClear();
    (ipcMain.handle as unknown as { mock: { calls: unknown[][] } }).mock.calls.length = 0;
    registerAuthHandlers();
    // Reset the remembered claim so each test starts from a signed-out state.
    await latestHandler("auth:sign-out")({});
    rpc.mockReset();
  });

  it("collapses concurrent balance reads into ONE rpc", async () => {
    const gate = deferred<{ data: unknown; error: null }>();
    rpc.mockImplementation(() => gate.promise);

    const handler = latestHandler("auth:get-credit-balance");
    const all = Promise.all([handler({}), handler({}), handler({}), handler({})]);
    gate.release({ data: { ok: true, balance_cents: 1234 }, error: null });

    const results = (await all) as { balanceCents: number }[];
    expect(rpc).toHaveBeenCalledTimes(1);
    // Every caller still gets the real answer, not a placeholder.
    for (const r of results) expect(r.balanceCents).toBe(1234);
  });

  it("carries the FULL balance shape through, including the period total", async () => {
    // Nothing tested this before: every mock in this file was two-key
    // `{ok, balance_cents}` and every assertion read only `balanceCents`. So the
    // handler could silently drop the split — which is exactly the bug that
    // shipped, twice, for `granted_cents`.
    rpc.mockResolvedValueOnce({
      data: {
        ok: true,
        balance_cents: 2200,
        granted_cents: 740,
        granted_total_cents: 1000,
        purchased_cents: 1460,
      },
      error: null,
    });

    const handler = latestHandler("auth:get-credit-balance");
    const r = (await handler({})) as {
      balanceCents: number;
      grantedCents: number | null;
      grantedTotalCents: number | null;
      purchasedCents: number | null;
    };

    expect(r.balanceCents).toBe(2200);
    expect(r.grantedCents).toBe(740);
    expect(r.grantedTotalCents).toBe(1000);
    expect(r.purchasedCents).toBe(1460);
    // The number the card actually renders: $2.60 of $10.00 used.
    expect(r.grantedTotalCents! - r.grantedCents!).toBe(260);
  });

  it("reports an absent split as NULL, never as zero", async () => {
    // A server older than this client returns only the total. Coalescing the
    // missing halves to 0 would render "$0.00 of $0.00 used" — a confident claim
    // that the allowance is empty, from a server that said nothing about it.
    rpc.mockResolvedValueOnce({ data: { ok: true, balance_cents: 500 }, error: null });

    const handler = latestHandler("auth:get-credit-balance");
    const r = (await handler({})) as {
      balanceCents: number;
      grantedCents: number | null;
      grantedTotalCents: number | null;
      purchasedCents: number | null;
    };

    expect(r.balanceCents).toBe(500);
    expect(r.grantedCents).toBeNull();
    expect(r.grantedTotalCents).toBeNull();
    expect(r.purchasedCents).toBeNull();
  });

  it("does NOT cache the balance past settlement — a later read is fresh", async () => {
    rpc.mockResolvedValueOnce({ data: { ok: true, balance_cents: 500 }, error: null });
    rpc.mockResolvedValueOnce({ data: { ok: true, balance_cents: 2000 }, error: null });

    const handler = latestHandler("auth:get-credit-balance");
    const first = (await handler({})) as { balanceCents: number };
    const second = (await handler({})) as { balanceCents: number };

    expect(first.balanceCents).toBe(500);
    expect(second.balanceCents).toBe(2000); // a top-up must show up immediately
    expect(rpc).toHaveBeenCalledTimes(2);
  });

  /**
   * Four signup-credit tests lived here and were deleted 2026-09-08 with the $1 trial.
   * They were the ORIGINAL reason this file exists — a write RPC firing four times in one
   * second is what exposed the duplication. The reads below still duplicate the same way,
   * so the coalescing they motivated stays and stays covered.
   */

  it("collapses a cold-cache plan-info burst into ONE subscription lookup", async () => {
    const gate = deferred<{ status: string; endsAt: null }>();
    getSubscriptionDetails.mockImplementation(() => gate.promise);

    const handler = latestHandler("auth:get-plan-info");
    const all = Promise.all([handler({}), handler({}), handler({})]);
    gate.release({ status: "active", endsAt: null });

    const results = (await all) as { success: boolean; subscriptionStatus: string }[];
    expect(getSubscriptionDetails).toHaveBeenCalledTimes(1);
    for (const r of results) {
      expect(r.success).toBe(true);
      expect(r.subscriptionStatus).toBe("active");
    }
  });
});
