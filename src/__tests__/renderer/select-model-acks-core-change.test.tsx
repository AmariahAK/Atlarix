/**
 * QA (app) #46: after picking Atlarix Auto, every chat showed "Your Atlarix
 * Core model changed from Auto to Glm 5.3": the user's own pick read as news,
 * in the wrong direction. A pick moves the notice's baseline to it.
 */
import React from "react";
import { describe, it, expect, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const ackCoreSlotChange = vi.fn(async () => ({ success: true }));
vi.mock("@/ipc/ipc_client", () => ({ IpcClient: { getInstance: () => ({ ackCoreSlotChange }) } }));
const updateSettings = vi.fn(async () => ({}));
vi.mock("@/hooks/useSettings", () => ({ useSettings: () => ({ updateSettings }) }));

import { useSelectModel } from "@/hooks/useSelectModel";

describe("picking a model", () => {
  it("is not announced as a Core model change", async () => {
    const qc = new QueryClient();
    const { result } = renderHook(() => useSelectModel(), {
      wrapper: ({ children }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>,
    });
    await act(async () => result.current({ provider: "compass", name: "core-auto" } as never));
    expect(updateSettings).toHaveBeenCalled();
    expect(ackCoreSlotChange).toHaveBeenCalled();
  });
});
