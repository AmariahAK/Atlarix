/**
 * useAuth is ONE shared store (2026-10-17). It used to be a plain hook: each of
 * its ~23 consumers ran its own session check (the July Supabase request storm),
 * its own IPC listeners, and on sign-in appended its own "Signed in" toast.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import type { AuthResolvedPayload } from "@/lib/auth/auth-ipc-bridge";

const emit = {
  resolved: [] as Array<(d: AuthResolvedPayload) => void>,
  oauth: [] as Array<(d: { user: { id: string; email: string; name: string } }) => void>,
};
vi.mock("@/lib/auth/auth-ipc-bridge", () => ({
  subscribeAuthResolved: (fn: (d: AuthResolvedPayload) => void) => {
    emit.resolved.push(fn);
    return () => void (emit.resolved = emit.resolved.filter((f) => f !== fn));
  },
  subscribeOAuthSuccess: (fn: (d: { user: { id: string; email: string; name: string } }) => void) => {
    emit.oauth.push(fn);
    return () => void (emit.oauth = emit.oauth.filter((f) => f !== fn));
  },
  subscribePlanChanged: () => () => {},
  subscribeSignInFailed: () => () => {},
}));

import { __resetAuthStoreForTests, useAuth } from "@/lib/auth/useAuth";

const invoke = vi.fn(async (channel: string) => {
  if (channel === "auth:get-current-user") {
    return { user: { id: "u-1", email: "owner@example.test", name: "Owner", plan: "pro" }, authResolved: true };
  }
  if (channel === "auth:get-plan-info") return { success: true, plan: "pro" };
  return { success: true };
});

beforeEach(() => {
  __resetAuthStoreForTests();
  invoke.mockClear();
  emit.resolved = [];
  emit.oauth = [];
  document.body.innerHTML = "";
  Object.defineProperty(window, "electron", {
    configurable: true,
    value: { ipcRenderer: { invoke, on: () => () => {}, removeListener: () => {} } },
  });
});

const CONSUMERS = 23;
const mountMany = () => Array.from({ length: CONSUMERS }, () => renderHook(() => useAuth()));

describe("useAuth, shared across every consumer", () => {
  it("checks the session ONCE however many components use it", async () => {
    const hooks = mountMany();
    await waitFor(() => expect(hooks.every((h) => h.result.current.isAuthenticated)).toBe(true));
    expect(invoke.mock.calls.filter(([c]) => c === "auth:get-current-user")).toHaveLength(1);
    // One subscription to each IPC event, not one per consumer.
    expect(emit.resolved).toHaveLength(1);
    expect(emit.oauth).toHaveLength(1);
  });

  it("every consumer sees a sign-out at once", async () => {
    const hooks = mountMany();
    await waitFor(() => expect(hooks[0]!.result.current.isAuthenticated).toBe(true));
    act(() => emit.resolved.forEach((f) => f({ user: null })));
    expect(hooks.every((h) => !h.result.current.isAuthenticated)).toBe(true);
  });

  it("a sign-in shows ONE 'Signed in' toast, not one per consumer", async () => {
    mountMany();
    await waitFor(() => expect(emit.oauth).toHaveLength(1));
    vi.useFakeTimers();
    act(() => emit.oauth.forEach((f) => f({ user: { id: "u-1", email: "owner@example.test", name: "Owner" } })));
    act(() => void vi.advanceTimersByTime(150));
    vi.useRealTimers();
    expect(document.body.innerHTML.match(/Signed in successfully/g) ?? []).toHaveLength(1);
  });

  it("stops listening when the last consumer goes, and starts again with the next", async () => {
    const hooks = mountMany();
    await waitFor(() => expect(emit.resolved).toHaveLength(1));
    hooks.forEach((h) => h.unmount());
    expect(emit.resolved).toHaveLength(0);
    renderHook(() => useAuth());
    expect(emit.resolved).toHaveLength(1);
  });
});
