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
import { I18nextProvider } from "react-i18next";
import { createI18n } from "@/lib/i18n";
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
  /** Background command / sub-agent job status. Drives the auto-wake path. */
  onBackgroundJobUpdate: (
    h: Handler<{ chatId: number; status: string; source?: string }>,
  ) => () => void;
  // ── test drivers ──
  emitStreamPhase: (payload: { chatId: number; phase: string; label: string }) => void;
  emitToolStart: (payload: { chatId: number; toolName: string; toolId?: string; toolArgs?: Record<string, unknown> }) => void;
  emitToolEnd: (payload: { chatId: number; toolId?: string; toolName?: string; status?: "success" | "error" }) => void;
  emitChatActivity: (payload: Record<string, unknown>) => void;
  emitBackgroundJobUpdate: (payload: {
    chatId: number;
    status: string;
    source?: string;
  }) => void;
  /** Main REFUSED a dispatch (a dropped system wake) — no stream, no terminal event. */
  onStreamDropped: (h: Handler<{ chatId: number; reason: string }>) => () => void;
  emitStreamDropped: (payload: { chatId: number; reason: string }) => void;
  /**
   * An operation is waiting for approval. Modelled explicitly (the Proxy's
   * catch-all returns a no-op unsubscribe and never fires) because the handler
   * has side effects worth pinning — it used to seize the right panel.
   */
  onPermissionRequest: (
    chatId: number,
    h: Handler<PermissionRequestPayload>,
  ) => () => void;
  emitPermissionRequest: (payload: PermissionRequestPayload) => void;
}

export type PermissionRequestPayload = {
  chatId: number;
  type: "permission-request";
  operationId: string;
  request: {
    __permission_required: true;
    operation: string;
    preview: unknown;
  };
};

export function makeFakeIpc(): FakeIpc {
  const phaseHandlers = new Set<Handler<{ chatId: number; phase: string; label: string }>>();
  const toolStartHandlers = new Set<Handler<{ chatId: number; toolName: string; toolId?: string; toolArgs?: Record<string, unknown> }>>();
  const toolEndHandlers = new Set<Handler<{ chatId: number; toolId?: string; toolName?: string; status?: "success" | "error" }>>();
  const activityHandlers = new Set<Handler<Record<string, unknown>>>();
  const bgJobHandlers = new Set<
    Handler<{ chatId: number; status: string; source?: string }>
  >();
  const droppedHandlers = new Set<Handler<{ chatId: number; reason: string }>>();
  const permissionHandlers = new Set<Handler<PermissionRequestPayload>>();

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
    onBackgroundJobUpdate: (h) => {
      bgJobHandlers.add(h);
      return () => bgJobHandlers.delete(h);
    },
    emitBackgroundJobUpdate: (payload) => {
      for (const h of bgJobHandlers) h(payload);
    },
    onStreamDropped: (h) => {
      droppedHandlers.add(h);
      return () => droppedHandlers.delete(h);
    },
    emitStreamDropped: (payload) => {
      for (const h of droppedHandlers) h(payload);
    },
    onPermissionRequest: (_chatId, h) => {
      permissionHandlers.add(h);
      return () => permissionHandlers.delete(h);
    },
    emitPermissionRequest: (payload) => {
      for (const h of permissionHandlers) h(payload);
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
      // Anything whose NAME says it returns a collection resolves to [], keyed on
      // the suffix as well as the prefix: "backgroundJobsList" / "subagentJobsList"
      // begin with neither get nor list, and a bare undefined had the caller
      // `.map()` over nothing — an unhandled rejection rather than a visible
      // failure, so the test passed while logging a crash.
      //
      // Deliberately NOT a `Results$` rule: `backgroundHasPendingResults` returns a
      // BOOLEAN, and `[]` is truthy — it would silently tell every test that a
      // wake has results to deliver.
      if (/^(get|list)/.test(prop) || prop.endsWith("List")) {
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
  // A FRESH i18n instance per render, initialised synchronously with the English
  // catalog. Synchronous is the load-bearing part: `t("some.key")` returns the
  // English string on the FIRST render, so every existing text assertion in this
  // suite keeps passing without being touched or awaited. An async init would
  // have meant rewriting ~94 assertions across 24 files to wait for a swap.
  const i18n = createI18n();
  const result = render(
    <I18nextProvider i18n={i18n}>
      <QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>
    </I18nextProvider>,
  );
  return { ...result, store, queryClient, i18n };
}
