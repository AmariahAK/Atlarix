/**
 * W2 (Windows fresh-install QA, 2026-11-07): once a sign-in started, the four
 * "Continue with …" buttons stayed disabled until `oauth-callback-success`
 * arrived. A rejected callback never sent one, and neither does a user who
 * closes the browser tab, so the sign-in screen stayed stuck until the app was
 * quit. Main now announces the failure, and the user can cancel.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import type { AuthResolvedPayload } from "@/lib/auth/auth-ipc-bridge";

let emitSignInFailed: (d: { message: string }) => void = () => {};

vi.mock("@/lib/auth/auth-ipc-bridge", () => ({
  subscribeAuthResolved: (_fn: (d: AuthResolvedPayload) => void) => () => {},
  subscribeOAuthSuccess: () => () => {},
  subscribePlanChanged: () => () => {},
  subscribeSignInFailed: (fn: (d: { message: string }) => void) => {
    emitSignInFailed = fn;
    return () => {};
  },
}));

import { __resetAuthStoreForTests, useAuth } from "@/lib/auth/useAuth";

const invoke = vi.fn(async (channel: string) => {
  if (channel === "auth:get-current-user") return { user: null, authResolved: true };
  return { success: true };
});

beforeEach(() => {
  __resetAuthStoreForTests();
  invoke.mockClear();
  Object.defineProperty(window, "electron", {
    configurable: true,
    value: { ipcRenderer: { invoke, on: () => () => {}, removeListener: () => {} } },
  });
});

describe("a pending sign-in always ends", () => {
  it("ends when main says the callback was rejected", async () => {
    const { result } = renderHook(() => useAuth());
    await act(() => result.current.signInWithEmail());
    expect(result.current.oauthPending).toBe(true);

    act(() => emitSignInFailed({ message: "That sign-in took too long. Start signing in again." }));

    await waitFor(() => expect(result.current.oauthPending).toBe(false));
    expect(result.current.oauthProvider).toBeNull();
  });

  it("ends when the user cancels, and main drops its watchdog", async () => {
    const { result } = renderHook(() => useAuth());
    await act(() => result.current.signInWithGoogle());
    expect(result.current.oauthPending).toBe(true);

    await act(() => result.current.cancelSignIn());

    expect(result.current.oauthPending).toBe(false);
    expect(invoke).toHaveBeenCalledWith("auth:cancel-sign-in");
  });

  it("asks you to finish in the browser in plain words", async () => {
    const { result } = renderHook(() => useAuth());
    await act(() => result.current.signInWithEmail());
    expect(result.current.oauthStatusLabel).not.toMatch(/\bin in\b/);
  });
});
