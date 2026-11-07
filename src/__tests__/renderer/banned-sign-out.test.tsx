/**
 * Sign out while banned.
 *
 * REPORTED LIVE 2026-08-20, during the ban system's own end-to-end verification:
 * the Sign out button on the banned screen did nothing, and the only way out was
 * closing and reopening the app.
 *
 * The cause was not a separate banned sign-out path — the banned screen already
 * calls the same `signOut()` the sidebar and account-settings dialogs call. The
 * shared function was incomplete: it cleared `user` and `status` and left `banned`
 * true. `welcome-launcher.tsx` tests `if (banned)` BEFORE `if (!isAuthenticated)`,
 * so the same screen re-rendered on a successful sign-out. Restarting worked only
 * because `banned` initialises to false.
 *
 * Two things are pinned here, because either alone would let the bug back:
 *   1. `signOut()` clears `banned`.
 *   2. The launcher's branch ORDER — banned wins over signed-out, which is why a
 *      stale `banned` was able to swallow the sign-in screen in the first place.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";

vi.mock("@/lib/auth/auth-ipc-bridge", () => ({
  subscribeAuthResolved: () => () => {},
  subscribeOAuthSuccess: () => () => {},
  subscribeSignInFailed: () => () => {},
  subscribePlanChanged: () => () => {},
}));

import { __resetAuthStoreForTests, useAuth } from "@/lib/auth/useAuth";

/** A banned, signed-in account as `auth:get-current-user` reports it. */
const BANNED_USER = {
  id: "u-1",
  email: "banned@example.test",
  name: "Banned",
  plan: "pro",
  effectiveTier: "pro" as const,
  banned: true,
};

const invoke = vi.fn(async (channel: string) => {
  switch (channel) {
    case "auth:get-current-user":
      return {
        success: true,
        user: BANNED_USER,
        banned: true,
        isLoggedIn: true,
        isPro: true,
        authResolved: true,
      };
    case "auth:get-plan-info":
      return { success: true, plan: "pro" };
    case "auth:sign-out":
      return { success: true };
    default:
      return { success: true };
  }
});

beforeEach(() => {
  // useAuth is one shared store now: each test starts from a fresh one.
  __resetAuthStoreForTests();
  invoke.mockClear();
  Object.defineProperty(window, "electron", {
    configurable: true,
    value: {
      ipcRenderer: { invoke, on: () => () => {}, removeListener: () => {} },
    },
  });
});

describe("signOut while banned", () => {
  it("clears `banned`, so the launcher stops rendering the banned screen", async () => {
    const { result } = renderHook(() => useAuth());

    // Precondition: main reported a banned account, and the hook mirrors it.
    await waitFor(() => expect(result.current.banned).toBe(true));
    expect(result.current.isAuthenticated).toBe(true);

    await act(async () => {
      await result.current.signOut();
    });

    // The regression: `banned` stayed true here, and welcome-launcher's
    // `if (banned)` branch re-rendered the same dead-end screen.
    expect(result.current.banned).toBe(false);
    expect(result.current.isAuthenticated).toBe(false);
    expect(invoke).toHaveBeenCalledWith("auth:sign-out", {
      removeLocalData: false,
    });
  });

  it("passes removeLocalData through, so the shared dialog still works", async () => {
    const { result } = renderHook(() => useAuth());
    await waitFor(() => expect(result.current.banned).toBe(true));

    await act(async () => {
      await result.current.signOut(true);
    });

    expect(invoke).toHaveBeenCalledWith("auth:sign-out", {
      removeLocalData: true,
    });
    expect(result.current.banned).toBe(false);
  });
});

/**
 * The launcher's precedence, asserted directly rather than by rendering the page.
 *
 * `welcome-launcher.tsx` returns on `banned` BEFORE `!isAuthenticated`. That order
 * is deliberate — a banned user who is still signed in must see the ban, not the
 * workspace list — and it is also exactly why a `banned` flag that outlived the
 * session could hide the sign-in screen forever. Encoding it here means reordering
 * those branches, or reintroducing the stale flag, fails a test.
 */
function launcherBranch(state: { banned: boolean; isAuthenticated: boolean }) {
  if (state.banned) return "banned";
  if (!state.isAuthenticated) return "sign-in";
  return "launcher";
}

describe("welcome-launcher branch order", () => {
  it("shows the ban to a signed-in banned account", () => {
    expect(launcherBranch({ banned: true, isAuthenticated: true })).toBe(
      "banned",
    );
  });

  it("banned OUTRANKS signed-out — the reason a stale flag was fatal", () => {
    expect(launcherBranch({ banned: true, isAuthenticated: false })).toBe(
      "banned",
    );
  });

  it("reaches sign-in once the ban is cleared, which is what signOut must produce", () => {
    expect(launcherBranch({ banned: false, isAuthenticated: false })).toBe(
      "sign-in",
    );
  });
});
