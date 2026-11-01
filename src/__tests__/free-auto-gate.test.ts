/**
 * Free Auto's daily limit is held on this side until it lifts: one refusal
 * from the proxy, then every resend is answered here with the same 429 and no
 * request (owner, 2026-10-28: "no retry until reset").
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const pays = { pro: false, cents: 0 as number | null };
vi.mock("@/lib/SubscriptionManager", () => ({ SubscriptionManager: { isPro: () => pays.pro } }));
vi.mock("@/lib/billing/credit-balance", () => ({ creditBalanceCents: async () => pays.cents }));

import {
  clearFreeAutoLimit,
  freeAutoResetsAt,
  freeAutoResetsAtFromBody,
  throughFreeAutoGate,
} from "@/lib/billing/free-auto-gate";
import { classifyCompassFailure } from "@/lib/chat/compass-failure-classifier";
import { isNetworkStreamError } from "@/ipc/handlers/chat_stream/network-retry";
import { FREE_LIMIT_MARKER } from "@/shared/billing_copy";

const limit = (resetsAt: number) =>
  new Response(JSON.stringify({ error: "free_usage_limit", resets_at: new Date(resetsAt).toISOString(), retry_after_seconds: 1 }), {
    status: 429,
  });

beforeEach(() => {
  clearFreeAutoLimit();
  pays.pro = false;
  pays.cents = 0;
});
afterEach(() => vi.useRealTimers());

describe("free Auto's limit is held until it lifts", () => {
  it("one refusal reaches the proxy; every resend is answered here, with the countdown", async () => {
    const at = Date.now() + 3 * 3600_000;
    const send = vi.fn(async () => limit(at));
    await throughFreeAutoGate(send);
    const again = await throughFreeAutoGate(send);
    const third = await throughFreeAutoGate(send);
    expect(send).toHaveBeenCalledTimes(1);
    expect(again.status).toBe(429);
    const body = await third.text();
    expect(freeAutoResetsAtFromBody(body)).toBe(at);
    // The held answer reads exactly like the proxy's: same message, never retried.
    const c = classifyCompassFailure(429, body);
    expect(c.message).toContain(FREE_LIMIT_MARKER);
    expect(c.message).toMatch(/Resets in (3h|2h 59m)\./);
    expect(isNetworkStreamError(Object.assign(new Error("x"), { name: "APICallError", statusCode: 429, isRetryable: true, responseBody: body }))).toBe(false);
  });

  it("lets the request through once the reset time has passed", async () => {
    vi.useFakeTimers({ now: Date.UTC(2026, 9, 29, 23, 0) });
    const send = vi.fn(async () => limit(Date.now() + 3600_000));
    await throughFreeAutoGate(send);
    vi.setSystemTime(Date.UTC(2026, 9, 30, 0, 1));
    const ok = vi.fn(async () => new Response("{}", { status: 200 }));
    expect((await throughFreeAutoGate(ok)).status).toBe(200);
    expect(ok).toHaveBeenCalledTimes(1);
    expect(freeAutoResetsAt()).toBeNull();
  });

  it("lets the request through as soon as the account pays (credit or Pro)", async () => {
    await throughFreeAutoGate(async () => limit(Date.now() + 3600_000));
    pays.cents = 1000;
    const ok = vi.fn(async () => new Response("{}", { status: 200 }));
    expect((await throughFreeAutoGate(ok)).status).toBe(200);
    expect(ok).toHaveBeenCalledTimes(1);
  });

  it("never holds longer than a day, whatever resets_at says", async () => {
    await throughFreeAutoGate(async () => limit(Date.now() + 365 * 24 * 3600_000));
    expect(freeAutoResetsAt()!).toBeLessThanOrEqual(Date.now() + 25 * 3600_000);
  });

  it("holds nothing for any other refusal (busy, credit, rate limit)", async () => {
    for (const body of [{ error: "free_busy" }, { error: "insufficient_credit" }, { error: "core_rate_limited", retry_after_seconds: 30 }]) {
      await throughFreeAutoGate(async () => new Response(JSON.stringify(body), { status: 429 }));
    }
    expect(freeAutoResetsAt()).toBeNull();
  });
});
