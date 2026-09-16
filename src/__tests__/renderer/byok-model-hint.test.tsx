/**
 * The BYOK model hint: who sees it, who does not, and that it only fires once.
 *
 * Every condition here is a state a real user has been in. The one that caused the
 * feature to exist is the last case in the first block: a key saved, the chat still
 * dispatching to Atlarix Core, and nothing on screen saying so.
 */

import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const settingsRef: { value: Record<string, unknown> } = { value: {} };
vi.mock("@/hooks/useSettings", () => ({
  useSettings: () => ({ settings: settingsRef.value, updateSettings: vi.fn() }),
}));

const authRef = {
  value: { isAuthenticated: true, authResolved: true } as {
    isAuthenticated: boolean;
    authResolved: boolean;
  },
};
vi.mock("@/lib/auth/useAuth", () => ({ useAuth: () => authRef.value }));

const modelsRef: {
  value: { data?: Record<string, unknown[]>; isLoading: boolean };
} = { value: { data: {}, isLoading: false } };
vi.mock("@/hooks/useLanguageModelsByProviders", () => ({
  useLanguageModelsByProviders: () => modelsRef.value,
}));

const invokeMock = vi.fn();

beforeEach(() => {
  /*
   * `mockReset`, not `mockClear` — one case below overrides the implementation to
   * simulate an already-dismissed hint, and `mockClear` leaves that override in
   * place for every later case. That is not hypothetical: it silently broke the
   * dismissal test, which then "failed" for a reason that had nothing to do with
   * dismissal.
   */
  invokeMock.mockReset();
  invokeMock.mockImplementation(async (channel: string) => {
    if (channel === "tour:get-state")
      return { featureTours: {}, firstRunCompleted: false, firstRunStep: 0 };
    return {};
  });
  (window as unknown as { electron: unknown }).electron = {
    ipcRenderer: { invoke: invokeMock },
  };
  settingsRef.value = {
    selectedModel: { provider: "compass", name: "core-1" },
  };
  authRef.value = { isAuthenticated: true, authResolved: true };
  modelsRef.value = {
    data: { openai: [{ apiName: "gpt-5", displayName: "GPT-5" }] },
    isLoading: false,
  };
});

import { useByokModelHint } from "@/hooks/useByokModelHint";
import { useHasByokProvider } from "@/hooks/useHasByokProvider";

function wrapper({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

describe("useHasByokProvider", () => {
  it("is FALSE for a Core-only install — the case isAnyProviderSetup() gets wrong", () => {
    // `compass` is a cloud provider in the catalog, so the obvious predicate
    // reports "a provider is set up" for a user who has supplied nothing.
    modelsRef.value = {
      data: { compass: [{ apiName: "core-1", displayName: "Core 1" }] },
      isLoading: false,
    };
    const { result } = renderHook(() => useHasByokProvider(), { wrapper });
    expect(result.current.hasByok).toBe(false);
  });

  it("is FALSE when only local runtimes are present", () => {
    modelsRef.value = {
      data: {
        ollama: [{ apiName: "llama", displayName: "Llama" }],
        lmstudio: [{ apiName: "qwen", displayName: "Qwen" }],
      },
      isLoading: false,
    };
    const { result } = renderHook(() => useHasByokProvider(), { wrapper });
    expect(result.current.hasByok).toBe(false);
  });

  it("ignores a provider that is listed but serves no models", () => {
    modelsRef.value = { data: { openai: [] }, isLoading: false };
    const { result } = renderHook(() => useHasByokProvider(), { wrapper });
    expect(result.current.hasByok).toBe(false);
  });

  it("is TRUE once a real provider has models", () => {
    const { result } = renderHook(() => useHasByokProvider(), { wrapper });
    expect(result.current.hasByok).toBe(true);
    expect(result.current.byokProviderIds).toEqual(["openai"]);
  });
});

describe("useByokModelHint", () => {
  it("shows for the state it exists for: own key, still dispatching to Core", async () => {
    const { result } = renderHook(() => useByokModelHint(), { wrapper });
    await waitFor(() => expect(result.current.showByokHint).toBe(true));
  });

  it("names the chord from the shortcuts table, not a literal", async () => {
    const { result } = renderHook(() => useByokModelHint(), { wrapper });
    await waitFor(() => expect(result.current.showByokHint).toBe(true));
    expect(result.current.changeModelChord).toMatch(/^(⌘J|Ctrl\+J)$/);
  });

  it("stays hidden once a BYOK model is already selected — nothing is wrong", async () => {
    settingsRef.value = {
      selectedModel: { provider: "openai", name: "gpt-5" },
    };
    const { result } = renderHook(() => useByokModelHint(), { wrapper });
    await new Promise((r) => setTimeout(r, 20));
    expect(result.current.showByokHint).toBe(false);
  });

  it("stays hidden with no BYOK provider — 'add a key' is a different hint", async () => {
    modelsRef.value = {
      data: { compass: [{ apiName: "core-1", displayName: "Core 1" }] },
      isLoading: false,
    };
    const { result } = renderHook(() => useByokModelHint(), { wrapper });
    await new Promise((r) => setTimeout(r, 20));
    expect(result.current.showByokHint).toBe(false);
  });

  it("stays hidden while auth is unresolved — that is 'no answer', not 'signed in'", async () => {
    authRef.value = { isAuthenticated: false, authResolved: false };
    const { result } = renderHook(() => useByokModelHint(), { wrapper });
    await new Promise((r) => setTimeout(r, 20));
    expect(result.current.showByokHint).toBe(false);
  });

  it("stays hidden when already dismissed — and reads that from MAIN, not localStorage", async () => {
    invokeMock.mockImplementation(async (channel: string) => {
      if (channel === "tour:get-state")
        return { featureTours: { "byok-model": { completed: true, step: 0 } } };
      return {};
    });
    const { result } = renderHook(() => useByokModelHint(), { wrapper });
    await new Promise((r) => setTimeout(r, 20));
    expect(result.current.showByokHint).toBe(false);
  });

  it("dismisses immediately and persists the record", async () => {
    const { result } = renderHook(() => useByokModelHint(), { wrapper });
    await waitFor(() => expect(result.current.showByokHint).toBe(true));

    act(() => result.current.dismissByokHint());

    // Optimistic: gone on click, not on the IPC round trip.
    expect(result.current.showByokHint).toBe(false);
    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith(
        "tour:set-state",
        expect.objectContaining({
          featureTours: expect.objectContaining({
            "byok-model": { completed: true, step: 0 },
          }),
        }),
      );
    });
  });
});
