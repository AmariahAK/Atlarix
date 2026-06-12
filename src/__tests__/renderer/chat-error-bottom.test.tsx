/**
 * v11.1: stream-failure banner renders pinned to the BOTTOM slot (above the
 * chat input) — not at the top of the page — and Retry restreams via
 * continueAfterQuestions.
 */

import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, fireEvent, screen } from "@testing-library/react";
import { chatErrorByIdAtom } from "@/atoms/chatAtoms";
import { makeFakeIpc, renderWithProviders } from "./helpers";

const fakeIpc = makeFakeIpc();
vi.mock("@/ipc/ipc_client", () => ({
  IpcClient: { getInstance: () => fakeIpc },
}));

const streamMessage = vi.fn();
vi.mock("@/hooks/useStreamChat", () => ({
  useStreamChat: () => ({ streamMessage }),
}));

// Heavy children stubbed — this test asserts layout order + retry wiring only.
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

const CHAT_ID = 42;

describe("chat error banner placement (v11.1)", () => {
  beforeEach(() => {
    streamMessage.mockClear();
    const { store } = renderWithProviders(<div />);
    store.set(chatErrorByIdAtom, new Map());
  });

  it("renders the error in the bottom slot, after the messages container", () => {
    const { store, container } = renderWithProviders(
      <SimpleInlineChat chatId={CHAT_ID} onSendMessage={() => {}} />,
    );
    act(() => {
      store.set(chatErrorByIdAtom, new Map([[CHAT_ID, "Model exploded"]]));
    });

    const errorBox = screen.getByTestId("chat-error-bottom");
    expect(errorBox).toBeInTheDocument();

    // The error box must come AFTER the scrollable messages area in DOM order
    // (pinned near the input, not at the top of the page).
    const scrollArea = container.querySelector(".overflow-y-auto");
    expect(scrollArea).toBeTruthy();
    expect(
      scrollArea!.compareDocumentPosition(errorBox) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    expect(
      errorBox.compareDocumentPosition(screen.getByTestId("chat-input")) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("Retry clears the error and restreams via continueAfterQuestions", () => {
    const { store } = renderWithProviders(
      <SimpleInlineChat chatId={CHAT_ID} onSendMessage={() => {}} />,
    );
    act(() => {
      store.set(chatErrorByIdAtom, new Map([[CHAT_ID, "Model exploded"]]));
    });

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    expect(streamMessage).toHaveBeenCalledWith({
      prompt: "",
      chatId: CHAT_ID,
      continueAfterQuestions: true,
    });
    expect(store.get(chatErrorByIdAtom).get(CHAT_ID)).toBeUndefined();
  });

  it("Dismiss clears the error", () => {
    const { store } = renderWithProviders(
      <SimpleInlineChat chatId={CHAT_ID} onSendMessage={() => {}} />,
    );
    act(() => {
      store.set(chatErrorByIdAtom, new Map([[CHAT_ID, "Model exploded"]]));
    });
    // ChatErrorBox dismiss button (X) — find by its accessible role inside the box.
    const errorBox = screen.getByTestId("chat-error-bottom");
    const dismiss = errorBox.querySelector("button");
    expect(dismiss).toBeTruthy();
    fireEvent.click(dismiss!);
    expect(store.get(chatErrorByIdAtom).get(CHAT_ID)).toBeUndefined();
  });
});
