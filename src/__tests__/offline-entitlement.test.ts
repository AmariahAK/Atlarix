/**
 * Offline entitlement fallback + the Supabase request deadline.
 *
 * Two defects this locks down:
 *
 *  1. `getUserPlan` returned `'free'` on ANY error and the tier cache was
 *     in-memory only, so a Pro user who launched without a network was silently
 *     downgraded for the whole session. Failing safe is right; failing to the
 *     CHEAPEST state for someone who paid is not.
 *  2. supabase-js sets no request timeout, so a black-hole network hung every
 *     call to the OS TCP timeout. All the `catch → return 'free'` handling in
 *     this codebase is correct and was simply UNREACHABLE, because a hang is not
 *     an exception.
 */

import { describe, expect, it, vi } from "vitest";
import {
  resolveOfflineEntitlement,
  type LastKnownEntitlement,
} from "@/lib/auth/offline-entitlement";
import {
  fetchWithTimeout,
  SUPABASE_REQUEST_TIMEOUT_MS,
} from "@/lib/auth/supabase-client";

const USER = "user-abc";
const NOW = Date.parse("2026-07-23T12:00:00Z");

const entitlement = (
  over: Partial<LastKnownEntitlement> = {},
): LastKnownEntitlement => ({
  userId: USER,
  plan: "pro",
  effectiveTier: "pro",
  subscriptionEndsAt: "2026-08-23T00:00:00Z",
  cachedAt: NOW - 60_000,
  ...over,
});

describe("honours a still-valid entitlement", () => {
  it("returns the cached plan when the subscription has not ended", () => {
    expect(resolveOfflineEntitlement(entitlement(), USER, NOW)).toEqual({
      plan: "pro",
      effectiveTier: "pro",
    });
  });

  it("works regardless of how stale the cache is, so long as it hasn't expired", () => {
    // A user offline for months still paid; `cachedAt` is metadata, the
    // subscription end date is the actual entitlement boundary.
    const old = entitlement({ cachedAt: NOW - 200 * 24 * 3600_000 });
    expect(resolveOfflineEntitlement(old, USER, NOW)?.plan).toBe("pro");
  });
});

describe("refuses to honour anything it shouldn't", () => {
  it("returns null once the subscription has ended", () => {
    const expired = entitlement({ subscriptionEndsAt: "2026-07-01T00:00:00Z" });
    expect(resolveOfflineEntitlement(expired, USER, NOW)).toBeNull();
  });

  it("returns null for a DIFFERENT user (shared machine / re-login)", () => {
    expect(
      resolveOfflineEntitlement(entitlement(), "someone-else", NOW),
    ).toBeNull();
  });

  it("returns null when there is no end date at all", () => {
    // The important one: absence of a boundary must never grant an UNBOUNDED
    // entitlement. That's the failure you'd only find months later, and it fails
    // in the direction of giving the product away.
    expect(
      resolveOfflineEntitlement(
        entitlement({ subscriptionEndsAt: null }),
        USER,
        NOW,
      ),
    ).toBeNull();
    expect(
      resolveOfflineEntitlement(
        entitlement({ subscriptionEndsAt: undefined }),
        USER,
        NOW,
      ),
    ).toBeNull();
  });

  it("returns null on an unparseable date rather than guessing", () => {
    expect(
      resolveOfflineEntitlement(
        entitlement({ subscriptionEndsAt: "soon" }),
        USER,
        NOW,
      ),
    ).toBeNull();
  });

  it("returns null when nothing was ever persisted", () => {
    expect(resolveOfflineEntitlement(undefined, USER, NOW)).toBeNull();
  });

  it("returns null when the user id is empty", () => {
    expect(resolveOfflineEntitlement(entitlement(), "", NOW)).toBeNull();
  });

  it("does not honour a free plan into pro", () => {
    const free = entitlement({ plan: "free", effectiveTier: "free" });
    expect(resolveOfflineEntitlement(free, USER, NOW)?.plan).toBe("free");
  });
});

describe("supabase request deadline", () => {
  it("is configured with a real, finite deadline", () => {
    // The bug was an ABSENT timeout, so assert one exists and is sane rather
    // than pinning an exact number.
    expect(SUPABASE_REQUEST_TIMEOUT_MS).toBeGreaterThan(0);
    expect(SUPABASE_REQUEST_TIMEOUT_MS).toBeLessThan(30_000);
  });

  it("rejects a hanging request instead of waiting forever", async () => {
    // A request that never settles — the black-hole network, which used to hang
    // to the OS TCP timeout (~75s) with nothing catchable.
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_input: unknown, init?: { signal?: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () =>
              reject(new DOMException("aborted", "AbortError")),
            );
          }),
      ),
    );

    await expect(
      fetchWithTimeout("https://example.test/never", undefined, 40),
    ).rejects.toThrow();

    vi.unstubAllGlobals();
  });

  it("still aborts when the CALLER's signal fires first", async () => {
    // supabase-js passes its own signal for cancellation; the deadline must
    // compose with it rather than replace it.
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_input: unknown, init?: { signal?: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () =>
              reject(new DOMException("aborted", "AbortError")),
            );
          }),
      ),
    );

    const caller = new AbortController();
    const p = fetchWithTimeout("https://example.test/never", {
      signal: caller.signal,
    });
    caller.abort();
    await expect(p).rejects.toThrow();

    vi.unstubAllGlobals();
  });

  it("passes a successful response straight through", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("ok", { status: 200 })),
    );
    const res = await fetchWithTimeout("https://example.test/ok");
    expect(res.status).toBe(200);
    vi.unstubAllGlobals();
  });
});
