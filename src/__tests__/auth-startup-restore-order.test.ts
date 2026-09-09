/**
 * A signed-in user used to stare at a logged-out UI for seconds on a cold launch.
 *
 * `restoreAuthSessionOnStartup()` resolves only AFTER the token refresh, and the
 * account was broadcast after it — so the UI waited on a 400ms empty-read retry plus
 * `[0, 1000, 3000]` of refresh backoff and three network round-trips. None of that
 * decides whether the user is signed in; the stored session already answers that, and
 * the refresh only rotates a token.
 *
 * These assert the ordering property that fixes it: the stored session is handed to the
 * caller BEFORE any refresh work, and every pre-existing resilience behaviour survives
 * (retry the empty read, never clear the session on a transient refresh failure).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { getSession, refreshSession } = vi.hoisted(() => ({
  getSession: vi.fn(),
  refreshSession: vi.fn(),
}));

// `getSupabaseClient()` THROWS without credentials, and the throw is swallowed by
// restoreAuthSessionOnStartup's own try/catch — so without these the whole function is
// a silent no-op and every assertion below would pass vacuously.
process.env.SUPABASE_URL = "https://test.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "test-anon-key";

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({ auth: { getSession, refreshSession } }),
}));

// Real secure storage reaches for Electron's safeStorage.
vi.mock("@/lib/auth/supabase-secure-storage", () => ({
  createSecureSupabaseStorage: () => ({
    getItem: async () => null,
    setItem: async () => {},
    removeItem: async () => {},
  }),
  clearSupabaseSecureStorage: () => {},
}));

import { restoreAuthSessionOnStartup } from "@/lib/auth/supabase-client";

/** Expired, so the refresh path always runs — the thing we must not wait on. */
const EXPIRED = {
  access_token: "t",
  expires_at: Math.floor(Date.now() / 1000) - 60,
  user: { id: "u1" },
};

const ok = (session: unknown) => ({ data: { session }, error: null });

beforeEach(() => {
  vi.clearAllMocks();
  refreshSession.mockResolvedValue({ data: { session: EXPIRED }, error: null });
});

describe("restoreAuthSessionOnStartup — stored session first", () => {
  it("hands over the stored session BEFORE attempting any refresh", async () => {
    getSession.mockResolvedValue(ok(EXPIRED));
    const order: string[] = [];
    refreshSession.mockImplementation(async () => {
      order.push("refresh");
      return { data: { session: EXPIRED }, error: null };
    });

    await restoreAuthSessionOnStartup({
      onStoredSession: () => {
        order.push("broadcast");
      },
    });

    // The whole point: broadcast is not behind the network.
    expect(order[0]).toBe("broadcast");
    expect(order).toContain("refresh");
  });

  it("passes the real stored session to the callback", async () => {
    getSession.mockResolvedValue(ok(EXPIRED));
    const onStoredSession = vi.fn();
    await restoreAuthSessionOnStartup({ onStoredSession });
    expect(onStoredSession).toHaveBeenCalledTimes(1);
    expect(onStoredSession.mock.calls[0]![0]).toMatchObject({
      access_token: "t",
    });
  });

  it("still retries an empty first read — the keychain can lag at launch", async () => {
    // v13.9: treating the first empty read as terminal was the "reopen logs me out" bug.
    getSession
      .mockResolvedValueOnce(ok(null))
      .mockResolvedValueOnce(ok(EXPIRED));
    const onStoredSession = vi.fn();
    await restoreAuthSessionOnStartup({ onStoredSession });
    expect(getSession).toHaveBeenCalledTimes(2);
    expect(onStoredSession).toHaveBeenCalledTimes(1);
  });

  it("does not invent a session when there genuinely isn't one", async () => {
    getSession.mockResolvedValue(ok(null));
    const onStoredSession = vi.fn();
    await restoreAuthSessionOnStartup({ onStoredSession });
    expect(onStoredSession).not.toHaveBeenCalled();
    expect(refreshSession).not.toHaveBeenCalled();
  });

  it("a throwing callback does not cost us the refresh", async () => {
    getSession.mockResolvedValue(ok(EXPIRED));
    await restoreAuthSessionOnStartup({
      onStoredSession: () => {
        throw new Error("renderer not ready");
      },
    });
    // The token still gets refreshed — a UI hiccup must not leave auth stale.
    expect(refreshSession).toHaveBeenCalled();
  });

  it("survives a failing refresh without clearing anything", async () => {
    getSession.mockResolvedValue(ok(EXPIRED));
    refreshSession.mockResolvedValue({
      data: { session: null },
      error: { message: "offline" },
    });
    const onStoredSession = vi.fn();
    // Must resolve, not throw: offline-at-launch is normal and the stored session
    // stays put for autoRefreshToken to recover later.
    await expect(
      restoreAuthSessionOnStartup({ onStoredSession }),
    ).resolves.toBeUndefined();
    expect(onStoredSession).toHaveBeenCalledTimes(1);
  });

  it("skips the refresh entirely for a session that is still valid", async () => {
    const valid = {
      ...EXPIRED,
      expires_at: Math.floor(Date.now() / 1000) + 3600,
    };
    getSession.mockResolvedValue(ok(valid));
    const onStoredSession = vi.fn();
    await restoreAuthSessionOnStartup({ onStoredSession });
    expect(onStoredSession).toHaveBeenCalledTimes(1);
    expect(refreshSession).not.toHaveBeenCalled();
  });

  it("works with no options at all (the old call shape)", async () => {
    getSession.mockResolvedValue(ok(EXPIRED));
    await expect(restoreAuthSessionOnStartup()).resolves.toBeUndefined();
  });
});
