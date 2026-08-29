/**
 * The renderer half of cross-window sign-out.
 *
 * `useAuth` is UNSHARED — every consumer holds its own copy of the account — so a
 * window that did not initiate the sign-out learns about it only from
 * `auth:resolved`. The handler used to early-return on a null user
 * (`if (!data?.user) return;`), which was harmless at startup (the renderer is
 * already signed out there) and exactly wrong for this: the second window kept
 * rendering a signed-in account until the app restarted.
 *
 * The early return was ALSO load-bearing, which is why it survived so long. The
 * bridge replays its last `auth:resolved` to late-mounting consumers, and that
 * cache was never refreshed on sign-in — so clearing on null would have signed out
 * any component mounted after a sign-in. That is fixed on the main side
 * (`updateSession` now broadcasts too); this pins the renderer half.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import type { AuthResolvedPayload } from "@/lib/auth/auth-ipc-bridge";

/** Lets a test play the part of main broadcasting to THIS window. */
let emitAuthResolved: (payload: AuthResolvedPayload) => void = () => {};

vi.mock("@/lib/auth/auth-ipc-bridge", () => ({
  subscribeAuthResolved: (fn: (d: AuthResolvedPayload) => void) => {
    emitAuthResolved = fn;
    return () => {};
  },
  subscribeOAuthSuccess: () => () => {},
  subscribePlanChanged: () => () => {},
}));

import { useAuth } from "@/lib/auth/useAuth";

const SIGNED_IN = {
  id: "u-1",
  email: "owner@example.test",
  name: "Owner",
  plan: "pro",
  effectiveTier: "pro" as const,
  banned: false,
};

const invoke = vi.fn(async (channel: string) => {
  switch (channel) {
    case "auth:get-current-user":
      return {
        success: true,
        user: SIGNED_IN,
        banned: false,
        isLoggedIn: true,
        isPro: true,
        authResolved: true,
      };
    case "auth:get-plan-info":
      return { success: true, plan: "pro" };
    default:
      return { success: true };
  }
});

beforeEach(() => {
  invoke.mockClear();
  Object.defineProperty(window, "electron", {
    configurable: true,
    value: { ipcRenderer: { invoke, on: () => () => {}, removeListener: () => {} } },
  });
});

describe("auth:resolved with no user", () => {
  it("signs this window out — THE BUG (it was ignored)", async () => {
    const { result } = renderHook(() => useAuth());

    // Precondition: this window believes it is signed in, as a second window
    // would while the FIRST one runs the sign-out.
    await waitFor(() => expect(result.current.isAuthenticated).toBe(true));

    act(() => {
      emitAuthResolved({ user: null, plan: "free" });
    });

    await waitFor(() => expect(result.current.isAuthenticated).toBe(false));
    expect(result.current.user).toBeNull();
  });

  it("still applies a payload that DOES carry a user", async () => {
    // The clear must not swallow the ordinary case: this same channel is how a
    // sign-in and a live ban flip arrive.
    const { result } = renderHook(() => useAuth());
    await waitFor(() => expect(result.current.isAuthenticated).toBe(true));

    act(() => {
      emitAuthResolved({ user: { ...SIGNED_IN, banned: true }, plan: "pro" });
    });

    await waitFor(() => expect(result.current.banned).toBe(true));
    expect(result.current.isAuthenticated).toBe(true);
  });
});
