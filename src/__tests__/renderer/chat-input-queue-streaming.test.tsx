/**
 * v13.1: while a turn is streaming the user can type and queue ONE follow-up
 * message (sent automatically when the turn ends). The textarea stays enabled,
 * Enter/Send queues, the stop square stays visible, and the slot is single.
 */

import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, fireEvent, screen } from "@testing-library/react";
import {
  isStreamingByIdAtom,
  chatInputValueAtom,
  queuedMessageByChatIdAtom,
} from "@/atoms/chatAtoms";
import { renderWithProviders } from "./helpers";

const CHAT_ID = 7;

// Heavy/irrelevant deps stubbed — this test asserts queue behavior only.
vi.mock("@/hooks/useSettings", () => ({
  useSettings: () => ({ settings: { selectedModel: { name: "m", provider: "p" } } }),
}));
vi.mock("@/lib/auth/useAuth", () => ({
  useAuth: () => ({ isAuthenticated: true, loading: false }),
}));
vi.mock("@/hooks/useAttachments", () => ({
  useAttachments: () => ({
    attachments: [],
    fileInputRef: { current: null },
    isDraggingOver: false,
    handleFileSelect: vi.fn(),
    removeAttachment: vi.fn(),
    handleDragOver: vi.fn(),
    handleDragLeave: vi.fn(),
    handleDrop: vi.fn(),
    clearAttachments: vi.fn(),
    handlePaste: vi.fn(),
    handlePasteCapture: vi.fn(),
  }),
}));
vi.mock("@/components/ChatInputControls", () => ({
  ChatInputControls: () => null,
}));
vi.mock("@/components/chat/TokenBar", () => ({ TokenBar: () => null }));
vi.mock("@/components/chat/AttachmentsList", () => ({ AttachmentsList: () => null }));
vi.mock("@/components/chat/SignInToChatNotice", () => ({ SignInToChatNotice: () => null }));
vi.mock("@/ipc/ipc_client", () => ({
  IpcClient: { getInstance: () => ({ cancelChatStream: vi.fn() }) },
}));

import { SimpleChatInput } from "@/components/SimpleChatInput";

describe("chat input — queue while streaming", () => {
  beforeEach(() => {
    const { store } = renderWithProviders(<div />);
    store.set(isStreamingByIdAtom, new Map([[CHAT_ID, true]]));
    store.set(chatInputValueAtom, "");
    store.set(queuedMessageByChatIdAtom, new Map());
  });

  it("keeps the textarea enabled and queues a message on submit while streaming", () => {
    const { store } = renderWithProviders(
      <SimpleChatInput chatId={CHAT_ID} onSubmit={() => {}} />,
    );
    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
    expect(textarea).not.toBeDisabled();

    act(() => {
      fireEvent.change(textarea, { target: { value: "do this next" } });
    });
    act(() => {
      fireEvent.keyDown(textarea, { key: "Enter" });
    });

    expect(store.get(queuedMessageByChatIdAtom).get(CHAT_ID)).toBe("do this next");
    expect(store.get(chatInputValueAtom)).toBe("");
    // The queued-row label is visible.
    expect(screen.getByText(/Queued — sends when the turn ends/)).toBeInTheDocument();
  });

  it("renders the stop button while streaming alongside send", () => {
    renderWithProviders(<SimpleChatInput chatId={CHAT_ID} onSubmit={() => {}} />);
    expect(screen.getByTitle("Stop generation")).toBeInTheDocument();
    expect(screen.getByTitle("Queue this message")).toBeInTheDocument();
  });

  it("does not queue a second message while the slot is full", () => {
    const { store } = renderWithProviders(
      <SimpleChatInput chatId={CHAT_ID} onSubmit={() => {}} />,
    );
    store.set(queuedMessageByChatIdAtom, new Map([[CHAT_ID, "first"]]));
    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
    act(() => {
      fireEvent.change(textarea, { target: { value: "second" } });
    });
    act(() => {
      fireEvent.keyDown(textarea, { key: "Enter" });
    });
    expect(store.get(queuedMessageByChatIdAtom).get(CHAT_ID)).toBe("first");
  });

  it("cancels the queued message via the × control", () => {
    const store = renderWithProviders(<div />).store;
    store.set(queuedMessageByChatIdAtom, new Map([[CHAT_ID, "queued"]]));
    renderWithProviders(<SimpleChatInput chatId={CHAT_ID} onSubmit={() => {}} />);
    fireEvent.click(screen.getByTitle("Cancel queued message"));
    expect(store.get(queuedMessageByChatIdAtom).has(CHAT_ID)).toBe(false);
  });
});
