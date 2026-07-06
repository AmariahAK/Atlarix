/**
 * Renderer test helpers — fake IpcClient + provider-wrapped render.
 *
 * Mock the IpcClient singleton at the module boundary from a test file:
 *
 *   const fake = makeFakeIpc();
 *   vi.mock("@/ipc/ipc_client", () => ({
 *     IpcClient: { getInstance: () => fakeIpcRef.current },
 *   }));
 *
 * The fake exposes `emit*` drivers so tests can script a stream:
 * tool start → activity → phase done, etc.
 */

import React from "react";
import { render } from "@testing-library/react";
import { getDefaultStore } from "jotai";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { vi } from "vitest";

type Handler<T> = (payload: T) => void;

export interface FakeIpc {
  // ── invoke-style methods (vi.fn — override return values per test) ──
  getApp: ReturnType<typeof vi.fn>;
  getChat: ReturnType<typeof vi.fn>;
  getChatMessages: ReturnType<typeof vi.fn>;
  editMessage: ReturnType<typeof vi.fn>;
  getUserSettings: ReturnType<typeof vi.fn>;
  setUserSettings: ReturnType<typeof vi.fn>;
  listWorkspaceSessions: ReturnType<typeof vi.fn>;
  streamMessage: ReturnType<typeof vi.fn>;
  cancelChatStream: ReturnType<typeof vi.fn>;
  openExternalUrl: ReturnType<typeof vi.fn>;
  // ── event registration (components subscribe; tests emit) ──
  onStreamPhase: (h: Handler<{ chatId: number; phase: string; label: string }>) => () => void;
  onToolIndicator: (
    onStart: Handler<{ chatId: number; toolName: string; toolId?: string; toolArgs?: Record<string, unknown> }>,
    onEnd: Handler<{ chatId: number; toolId?: string; toolName?: string; status?: "success" | "error" }>,
  ) => () => void;
  onChatActivity: (h: Handler<Record<string, unknown>>) => () => void;
  // ── test drivers ──
  emitStreamPhase: (payload: { chatId: number; phase: string; label: string }) => void;
  emitToolStart: (payload: { chatId: number; toolName: string; toolId?: string; toolArgs?: Record<string, unknown> }) => void;
  emitToolEnd: (payload: { chatId: number; toolId?: string; toolName?: string; status?: "success" | "error" }) => void;
  emitChatActivity: (payload: Record<string, unknown>) => void;
}

export function makeFakeIpc(): FakeIpc {
  const phaseHandlers = new Set<Handler<{ chatId: number; phase: string; label: string }>>();
  const toolStartHandlers = new Set<Handler<{ chatId: number; toolName: string; toolId?: string; toolArgs?: Record<string, unknown> }>>();
  const toolEndHandlers = new Set<Handler<{ chatId: number; toolId?: string; toolName?: string; status?: "success" | "error" }>>();
  const activityHandlers = new Set<Handler<Record<string, unknown>>>();

  const fake: FakeIpc = {
    getApp: vi.fn(async () => null),
    getChat: vi.fn(async () => ({ messages: [], appId: null })),
    getChatMessages: vi.fn(async () => []),
    editMessage: vi.fn(async () => undefined),
    getUserSettings: vi.fn(async () => ({})),
    setUserSettings: vi.fn(async () => ({})),
    listWorkspaceSessions: vi.fn(async () => []),
    streamMessage: vi.fn(async () => undefined),
    cancelChatStream: vi.fn(async () => undefined),
    openExternalUrl: vi.fn(async () => undefined),
    onStreamPhase: (h) => {
      phaseHandlers.add(h);
      return () => phaseHandlers.delete(h);
    },
    onToolIndicator: (onStart, onEnd) => {
      toolStartHandlers.add(onStart);
      toolEndHandlers.add(onEnd);
      return () => {
        toolStartHandlers.delete(onStart);
        toolEndHandlers.delete(onEnd);
      };
    },
    onChatActivity: (h) => {
      activityHandlers.add(h);
      return () => activityHandlers.delete(h);
    },
    emitStreamPhase: (payload) => {
      for (const h of phaseHandlers) h(payload);
    },
    emitToolStart: (payload) => {
      for (const h of toolStartHandlers) h(payload);
    },
    emitToolEnd: (payload) => {
      for (const h of toolEndHandlers) h(payload);
    },
    emitChatActivity: (payload) => {
      for (const h of activityHandlers) h(payload);
    },
  };

  // The real IpcClient has a large surface; components under test may touch
  // methods the fake doesn't model. A Proxy fills the gaps: `on*`/`subscribe*`
  // registrations return an unsubscribe, list-ish getters resolve to [],
  // everything else resolves to undefined.
  return new Proxy(fake, {
    get(target, prop: string) {
      if (prop in target) return target[prop as keyof FakeIpc];
      if (prop.startsWith("on") || prop.startsWith("subscribe")) {
        return () => () => {};
      }
      if (/^(get|list)/.test(prop) && /s$|List|Permissions|Sessions/.test(prop)) {
        return async () => [];
      }
      return async () => undefined;
    },
  }) as FakeIpc;
}

/**
 * Render with a react-query client. Components in this app mix `useAtom*`
 * hooks with direct `getDefaultStore()` access, so tests intentionally use
 * the DEFAULT Jotai store (no Provider) — set/reset atoms via the returned
 * `store` in each test.
 */
export function renderWithProviders(ui: React.ReactElement) {
  const store = getDefaultStore();
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const result = render(
    <QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>,
  );
  return { ...result, store, queryClient };
}
