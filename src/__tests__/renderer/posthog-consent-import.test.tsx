/**
 * Two settings loads in a row, while the PostHog client module is still
 * loading (its bundled recorder is large): each must reach the finished module.
 * posthog-client once imported useSettings for the consent check, so a test
 * runner handed the second load the half-loaded module, and
 * `syncPostHogConsent` read `client` before its `let` line (main CI, 15.10.1).
 */
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { makeFakeIpc } from "./helpers";

const fakeIpc = makeFakeIpc();
fakeIpc.getUserSettings = vi.fn(async () => ({ telemetryConsent: "opted_in", telemetryUserId: "anon-1" }));
vi.mock("@/ipc/ipc_client", () => ({ IpcClient: { getInstance: () => fakeIpc } }));
vi.mock("posthog-js/react", () => ({ usePostHog: () => ({ capture: vi.fn() }) }));
const init = vi.fn(() => ({}));
vi.mock("posthog-js", () => ({
  default: { init, identify: vi.fn(), register: vi.fn(), startSessionRecording: vi.fn(), stopSessionRecording: vi.fn() },
}));
vi.mock("posthog-js/dist/posthog-recorder", () => ({}));
// The client module's last import takes a while, as a cold transform does.
vi.mock("@/lib/analytics/replay", async (real) => {
  await new Promise((r) => setTimeout(r, 50));
  return real();
});

import { useSettings } from "@/hooks/useSettings";

// A working Storage whatever the Node version (Node's own can shadow jsdom's).
const stored = new Map<string, string>();
Object.defineProperty(window, "localStorage", {
  configurable: true,
  value: {
    getItem: (k: string) => stored.get(k) ?? null,
    setItem: (k: string, v: string) => void stored.set(k, String(v)),
    removeItem: (k: string) => void stored.delete(k),
  },
});

const rejections: unknown[] = [];
const onRejection = (e: unknown) => void rejections.push(e);
afterEach(() => void process.off("unhandledRejection", onRejection));

describe("the consent hook and the PostHog client", () => {
  it("a second settings load while the client module loads: it reaches the finished module", async () => {
    process.on("unhandledRejection", onRejection);
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={new QueryClient()}>{children}</QueryClientProvider>
    );
    // The client module is not loaded yet: the hook's first load starts it.
    const { result } = renderHook(() => useSettings(), { wrapper });
    await waitFor(() => expect(fakeIpc.getUserSettings).toHaveBeenCalledTimes(1));
    // Mid-load (its last import is still on its way), settings load again.
    await new Promise((r) => setTimeout(r, 25));
    await result.current.refreshSettings();
    await new Promise((r) => setTimeout(r, 200));
    expect(rejections.map(String)).toEqual([]);
    expect(result.current.error).toBeNull();
    // And it works: with its config (renderer.tsx's part), a load starts it.
    const m = await import("@/lib/analytics/posthog-client");
    m.setPostHogConfig("phc_key", "anon-1", "15.10.1", 0);
    await result.current.refreshSettings();
    await waitFor(() => expect(init).toHaveBeenCalledTimes(1));
  });
});
