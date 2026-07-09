/**
 * F2: the chat message list is render-capped — only the last RENDER_CAP (120)
 * messages mount, with a "Show earlier messages" affordance to reveal more, so a
 * long session doesn't grow the DOM unbounded. The streaming/last message is
 * always in the window.
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
vi.mock("@/lib/open-workspace-session", () => ({
  startNewWorkspaceConversation: vi.fn(),
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
      <SimpleInlineChat chatId={CHAT_ID} onSendMessage={() => {}} />,
    );
    act(() => {
      store.set(chatMessagesByIdAtom, new Map([[CHAT_ID, makeMessages(total) as never]]));
    });

    // Only the last 120 render; 30 are hidden behind the button.
    expect(screen.getAllByTestId("message")).toHaveLength(RENDER_CAP);
    const showEarlier = screen.getByRole("button", { name: /Show earlier messages \(30 hidden\)/i });
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
      <SimpleInlineChat chatId={CHAT_ID} onSendMessage={() => {}} />,
    );
    act(() => {
      store.set(chatMessagesByIdAtom, new Map([[CHAT_ID, makeMessages(20) as never]]));
    });
    expect(screen.getAllByTestId("message")).toHaveLength(20);
    expect(
      screen.queryByRole("button", { name: /Show earlier messages/i }),
    ).not.toBeInTheDocument();
  });
});
