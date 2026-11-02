/**
 * F2: the render-all FALLBACK path (virtualizeHistory=false) is render-capped —
 * only the last RENDER_CAP (120) messages mount, with a "Show earlier messages"
 * affordance to reveal more. In the default VIRTUALIZED path react-virtuoso
 * windows the DOM instead, so these tests pin `virtualizeHistory={false}` to keep
 * the kill-switch fallback covered. A separate test asserts the virtualized
 * branch mounts by default.
 */

import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, fireEvent, screen } from "@testing-library/react";
import { chatMessagesByIdAtom } from "@/atoms/chatAtoms";
import { makeFakeIpc, renderWithProviders } from "./helpers";

const fakeIpc = makeFakeIpc();
vi.mock("@/ipc/ipc_client", () => ({
  IpcClient: { getInstance: () => fakeIpc },
}));
vi.mock("@/hooks/useStreamChat", () => ({
  useStreamChat: () => ({ streamMessage: vi.fn() }),
}));
vi.mock("@/components/SimpleChatInput", () => ({
  SimpleChatInput: () => <div data-testid="chat-input" />,
}));
vi.mock("@/components/SimpleMessage", () => ({
  SimpleMessage: () => <div data-testid="message" />,
}));
vi.mock("@/components/chat/InlineUserQuestions", () => ({
  InlineUserQuestions: () => null,
}));
vi.mock("@/components/chat/InlineStreamStatus", () => ({
  InlineStreamStatus: () => null,
}));
vi.mock("@/components/chat/LoadedSessionBanner", () => ({
  LoadedSessionBanner: () => null,
}));
// The rating card pulls useWorkModeSelection → useSettings → the PostHog client
// (and its recorder bundle). On CI that chain could still be loading when the
// file's environment was torn down: 24 "Cannot load replay.ts" unhandled errors
// failed main's run for 15.11.1. Nothing here is about the card.
vi.mock("@/components/chat/SessionRatingCard", () => ({
  SessionRatingCard: () => null,
  openFeedbackFor: vi.fn(),
}));
// The same chain came back through ChatErrorBox → open-settings-section → the
// router → TitleBar → useSettings (24 errors on dev b4096620), so cut it at both
// ends instead of one component at a time.
vi.mock("@/lib/open-settings-section", () => ({
  openSettingsSection: vi.fn(),
}));
vi.mock("@/lib/analytics/posthog-client", () => ({
  getPostHogClient: () => null,
  setPostHogConfig: vi.fn(),
  ensurePostHogInitialized: () => null,
  syncPostHogConsent: vi.fn(),
}));
// The replay module is loaded dynamically by posthog-client; mock it to prevent
// teardown errors when the async import resolves after the test environment ends.
vi.mock("@/lib/analytics/replay", () => ({
  initReplay: vi.fn(),
  stopReplay: vi.fn(),
}));
vi.mock("@/lib/open-workspace-session", () => ({
  startNewWorkspaceConversation: vi.fn(),
}));
vi.mock("@/components/VirtualizedMessageList", () => ({
  // Virtuoso needs a real viewport (absent in jsdom); mock it to a marker so we
  // can assert the default path selects the virtualized branch.
  VirtualizedMessageList: () => <div data-testid="virtualized-list" />,
}));

import { SimpleInlineChat } from "@/components/SimpleInlineChat";

const CHAT_ID = 7;
const RENDER_CAP = 120;

function makeMessages(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    id: i + 1,
    role: i % 2 === 0 ? "user" : "assistant",
    content: `msg ${i + 1}`,
  }));
}

describe("chat render-cap (F2)", () => {
  beforeEach(() => {
    const { store } = renderWithProviders(<div />);
    store.set(chatMessagesByIdAtom, new Map());
  });

  it("mounts only the last RENDER_CAP messages + a 'Show earlier' button, then reveals more on click", () => {
    const total = 150;
    const { store } = renderWithProviders(
      <SimpleInlineChat
        chatId={CHAT_ID}
        onSendMessage={() => {}}
        virtualizeHistory={false}
      />,
    );
    act(() => {
      store.set(
        chatMessagesByIdAtom,
        new Map([[CHAT_ID, makeMessages(total) as never]]),
      );
    });

    // Only the last 120 render; 30 are hidden behind the button.
    expect(screen.getAllByTestId("message")).toHaveLength(RENDER_CAP);
    const showEarlier = screen.getByRole("button", {
      name: /Show earlier messages \(30 hidden\)/i,
    });
    expect(showEarlier).toBeInTheDocument();

    // Reveal the rest → all 150 render, button gone.
    act(() => fireEvent.click(showEarlier));
    expect(screen.getAllByTestId("message")).toHaveLength(total);
    expect(
      screen.queryByRole("button", { name: /Show earlier messages/i }),
    ).not.toBeInTheDocument();
  });

  it("renders all messages with no button when under the cap", () => {
    const { store } = renderWithProviders(
      <SimpleInlineChat
        chatId={CHAT_ID}
        onSendMessage={() => {}}
        virtualizeHistory={false}
      />,
    );
    act(() => {
      store.set(
        chatMessagesByIdAtom,
        new Map([[CHAT_ID, makeMessages(20) as never]]),
      );
    });
    expect(screen.getAllByTestId("message")).toHaveLength(20);
    expect(
      screen.queryByRole("button", { name: /Show earlier messages/i }),
    ).not.toBeInTheDocument();
  });

  it("uses the virtualized list by default (flag ON) when there are messages", () => {
    const { store } = renderWithProviders(
      <SimpleInlineChat chatId={CHAT_ID} onSendMessage={() => {}} />,
    );
    act(() => {
      store.set(
        chatMessagesByIdAtom,
        new Map([[CHAT_ID, makeMessages(5) as never]]),
      );
    });
    // Default path renders the (mocked) virtualizer, not the render-all list.
    expect(screen.getByTestId("virtualized-list")).toBeInTheDocument();
    expect(screen.queryByTestId("message")).not.toBeInTheDocument();
  });
});
