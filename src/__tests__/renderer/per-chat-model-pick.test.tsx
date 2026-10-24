/**
 * QA (ai-44, joint run): picking a model in one chat changed every chat's model.
 * Now (15.11.1) a pick belongs to the chat in front: its row and its chip take
 * it, the app's setting takes it only as what a NEW chat starts with, and
 * switching to another chat shows that chat's own model.
 */
import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { getDefaultStore } from "jotai";

const setFrontSession = vi.fn(async () => ({ ok: true }));
let sessionModelListener: ((p: { sessionId: string; model: unknown }) => void) | null = null;
vi.mock("@/ipc/ipc_client", () => ({
  IpcClient: {
    getInstance: () => ({
      ackCoreSlotChange: async () => ({}),
      setFrontSession,
      onSessionModel: (l: typeof sessionModelListener) => {
        sessionModelListener = l;
        return () => {};
      },
    }),
  },
}));
const settings = { selectedModel: { provider: "anthropic", name: "claude-haiku-4-5" }, effort: "", deepThinking: false };
const updateSettings = vi.fn(async (patch: Record<string, unknown>) => Object.assign(settings, patch));
vi.mock("@/hooks/useSettings", () => ({ useSettings: () => ({ settings, updateSettings }) }));

import { useSelectModel } from "@/hooks/useSelectModel";
import { useChatModel } from "@/hooks/useChatModel";
import { activateWorkspaceSession, subscribeToFrontSessionModel } from "@/lib/open-workspace-session";
import { activeSessionModelAtom } from "@/atoms/sessionAtoms";

const wrapper = ({ children }: { children: React.ReactNode }) => (
  <QueryClientProvider client={new QueryClient()}>{children}</QueryClientProvider>
);

beforeEach(() => {
  setFrontSession.mockClear();
  updateSettings.mockClear();
});

describe("a model pick is the chat's", () => {
  it("tells main the chat in front, shows the pick at once and main's stored answer; switching chats shows each one's own", async () => {
    const unsub = subscribeToFrontSessionModel();
    activateWorkspaceSession("chat-b", "build", { provider: "openai", name: "gpt-5", effort: "low" });
    activateWorkspaceSession("chat-a", "ask", { provider: "anthropic", name: "claude-haiku-4-5" });
    // Main stores a model written from this window on this chat (front-session.ts).
    expect(setFrontSession).toHaveBeenLastCalledWith("chat-a");

    const pick = renderHook(() => useSelectModel(), { wrapper });
    await act(async () => pick.result.current({ provider: "bedrock", name: "nova-micro" } as never));
    expect(getDefaultStore().get(activeSessionModelAtom)).toEqual({ provider: "bedrock", name: "nova-micro" });
    expect(updateSettings).toHaveBeenCalledWith({ selectedModel: { provider: "bedrock", name: "nova-micro" } });

    // Main's answer (the level the new model keeps) replaces the optimistic copy;
    // one for a chat not in front changes nothing here.
    act(() => sessionModelListener?.({ sessionId: "chat-b", model: { provider: "x", name: "y" } }));
    act(() =>
      sessionModelListener?.({ sessionId: "chat-a", model: { provider: "bedrock", name: "nova-micro", effort: "high" } }),
    );
    expect(getDefaultStore().get(activeSessionModelAtom)).toEqual({
      provider: "bedrock",
      name: "nova-micro",
      effort: "high",
    });
    unsub();

    const shown = renderHook(() => useChatModel(-1), { wrapper });
    expect(shown.result.current.model).toEqual({ provider: "bedrock", name: "nova-micro" });

    // Back to chat B: its own model, not the one just picked in A.
    act(() => activateWorkspaceSession("chat-b", "build", { provider: "openai", name: "gpt-5", effort: "low" }));
    shown.rerender();
    expect(shown.result.current.model).toEqual({ provider: "openai", name: "gpt-5" });
    expect(shown.result.current.effort).toBe("low");
  });

  it("a chat with nothing stored follows the app's default", async () => {
    act(() => activateWorkspaceSession("fresh", null, null));
    const shown = renderHook(() => useChatModel(-1), { wrapper });
    expect(shown.result.current.model).toEqual(settings.selectedModel);
  });
});

describe("switching chats by tab", () => {
  it("never leaves the previous chat's model in front while the new one loads", () => {
    act(() => activateWorkspaceSession("chat-a", "ask", { provider: "openai", name: "gpt-5" }));
    act(() => activateWorkspaceSession("chat-b", undefined, undefined));
    expect(getDefaultStore().get(activeSessionModelAtom)).toBeNull();
    // The same chat again (a streaming fast path): what is there stays.
    act(() => activateWorkspaceSession("chat-b", undefined, { provider: "bedrock", name: "nova" }));
    act(() => activateWorkspaceSession("chat-b", undefined, undefined));
    expect(getDefaultStore().get(activeSessionModelAtom)).toEqual({ provider: "bedrock", name: "nova" });
  });
});
