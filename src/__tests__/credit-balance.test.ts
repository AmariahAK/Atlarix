import { beforeEach, describe, expect, it, vi } from "vitest";

const rpc = vi.fn();
vi.mock("@/lib/auth/supabase-client", () => ({
  getSession: vi.fn(async () => ({ user: { id: "u" } })),
  getSupabaseClient: () => ({ rpc }),
}));

describe("the balance is read once for everyone asking at the same moment", () => {
  beforeEach(() => {
    vi.resetModules();
    rpc.mockReset();
    rpc.mockResolvedValue({ data: { balance_cents: 1234 }, error: null });
  });

  it("four parallel relic calls make one request", async () => {
    const { creditBalanceCents } = await import("@/lib/billing/credit-balance");
    const all = await Promise.all([creditBalanceCents(), creditBalanceCents(), creditBalanceCents(), creditBalanceCents()]);
    expect(all).toEqual([1234, 1234, 1234, 1234]);
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it("an older answer than the caller accepts is read again", async () => {
    const { creditBalanceCents } = await import("@/lib/billing/credit-balance");
    await creditBalanceCents();
    await creditBalanceCents(-1);
    expect(rpc).toHaveBeenCalledTimes(2);
  });
});
