/**
 * `useAuth` is a plain hook with no shared state and ~20 consumers, so each one runs
 * its own `checkSession()` on mount. Before this, that meant every consumer
 * independently fired `auth:claim-signup-credit` and the Supabase-backed reads — the
 * project's API logs showed four `claim_signup_credit` calls inside a single second for
 * a grant that can only ever happen once.
 *
 * These assert the two properties that fix it: overlapping reads share one upstream
 * call, and the one-time claim is asked for once per signed-in session.
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
    canCreateWorkspace: async () => ({ allowed: true, maxAllowed: 1, currentCount: 0 }),
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

  it("claims the signup credit ONCE even when every consumer asks", async () => {
    rpc.mockResolvedValue({
      data: { ok: true, balance_cents: 100, granted: true },
      error: null,
    });
    const handler = latestHandler("auth:claim-signup-credit");

    await Promise.all([handler({}), handler({}), handler({}), handler({})]);
    await handler({}); // a later session check, long after the burst
    await handler({});

    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it("replays the same result to later callers", async () => {
    rpc.mockResolvedValue({
      data: { ok: true, balance_cents: 100, granted: true },
      error: null,
    });
    const handler = latestHandler("auth:claim-signup-credit");
    const first = (await handler({})) as { granted: boolean; balanceCents: number };
    const later = (await handler({})) as { granted: boolean; balanceCents: number };
    expect(later).toEqual(first);
  });

  it("does NOT remember a FAILED claim — a real grant is never lost", async () => {
    rpc.mockResolvedValueOnce({ data: null, error: { message: "network down" } });
    const handler = latestHandler("auth:claim-signup-credit");
    const failed = (await handler({})) as { ok: boolean };
    expect(failed.ok).toBe(false);

    rpc.mockResolvedValueOnce({
      data: { ok: true, balance_cents: 100, granted: true },
      error: null,
    });
    const retried = (await handler({})) as { ok: boolean; granted: boolean };
    expect(retried.ok).toBe(true);
    expect(retried.granted).toBe(true);
    expect(rpc).toHaveBeenCalledTimes(2);
  });

  it("lets a DIFFERENT account claim after sign-out", async () => {
    rpc.mockResolvedValue({
      data: { ok: true, balance_cents: 100, granted: true },
      error: null,
    });
    const claim = latestHandler("auth:claim-signup-credit");
    await claim({});
    expect(rpc).toHaveBeenCalledTimes(1);

    await latestHandler("auth:sign-out")({});
    await claim({});
    expect(rpc).toHaveBeenCalledTimes(2);
  });

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
