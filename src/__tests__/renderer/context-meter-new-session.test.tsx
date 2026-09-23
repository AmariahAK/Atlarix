/**
 * Reported 2026-09-23: session 1 sits at 29% context; pressing New shows 29%
 * on the fresh session until its first message is sent.
 *
 * Cause: the token-count query kept the PREVIOUS query's data as the
 * placeholder while the new chat's count loaded, and chat id is part of that
 * key — so the old chat's number was shown for the new chat.
 */
import React from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";

const countTokens = vi.fn();
vi.mock("@/ipc/ipc_client", () => ({
  IpcClient: { getInstance: () => ({ countTokens }) },
}));
vi.mock("@/hooks/useWorkModeSelection", () => ({
  useWorkModeSelection: () => ({ workMode: "build" }),
}));

import { useContextTokenCount } from "@/hooks/useCountTokens";

function wrapper({ children }: { children: React.ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

describe("context meter across a new session", () => {
  it("never shows the previous chat's count for a new chat", async () => {
    countTokens.mockResolvedValueOnce({ estimatedTotalTokens: 58_000 });
    const { result, rerender } = renderHook(
      ({ chatId }) => useContextTokenCount(chatId),
      { wrapper, initialProps: { chatId: -1 } },
    );
    await waitFor(() =>
      expect(result.current.result?.estimatedTotalTokens).toBe(58_000),
    );

    // The new session's count is still in flight.
    let resolveNew: (v: unknown) => void = () => {};
    countTokens.mockReturnValueOnce(
      new Promise((r) => {
        resolveNew = r;
      }),
    );
    rerender({ chatId: -2 });
    expect(result.current.result).toBeNull();

    await act(async () => resolveNew({ estimatedTotalTokens: 10_864 }));
    await waitFor(() =>
      expect(result.current.result?.estimatedTotalTokens).toBe(10_864),
    );
  });

  it("still holds the previous count while the SAME chat refetches", async () => {
    countTokens.mockResolvedValueOnce({ estimatedTotalTokens: 20_000 });
    const client = new QueryClient();
    const Wrap = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(() => useContextTokenCount(-5), {
      wrapper: Wrap,
    });
    await waitFor(() =>
      expect(result.current.result?.estimatedTotalTokens).toBe(20_000),
    );
    countTokens.mockReturnValueOnce(new Promise(() => {}));
    await act(async () => {
      void client.invalidateQueries();
    });
    expect(result.current.result?.estimatedTotalTokens).toBe(20_000);
  });
});
