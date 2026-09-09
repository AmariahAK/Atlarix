/**
 * Mid-turn messages, from the composer's side.
 *
 * WHAT CHANGED HERE, and why the old assertions are gone. The composer used to
 * own the queue: a renderer atom holding ONE string, flushed as a fresh turn
 * when the stream ended. It now hands each message to MAIN, which delivers it
 * into the running turn — so the things worth pinning moved too:
 *  - Enter mid-stream RECORDS over IPC (it no longer writes the atom itself).
 *  - A SECOND message appends instead of being silently rejected. That
 *    rejection was the actual defect: Enter bypasses the disabled Send button,
 *    so the user got no feedback and their text just sat in the box.
 *  - Cancel goes over IPC too, and the chip repaints from what main returns.
 *  - The label says "running turn", not "when the turn ends".
 *
 * v13.2's ONE-action-slot rule (Stop replaces Send while streaming) is
 * unchanged and still pinned.
 */

import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import {
  isStreamingByIdAtom,
  chatInputValueAtom,
  pendingInterjectionsByChatIdAtom,
} from "@/atoms/chatAtoms";
import { renderWithProviders } from "./helpers";

const CHAT_ID = 7;

// Heavy/irrelevant deps stubbed — this test asserts composer behavior only.
vi.mock("@/hooks/useSettings", () => ({
  useSettings: () => ({
    settings: { selectedModel: { name: "m", provider: "p" } },
  }),
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
  }),
}));
vi.mock("@/components/ChatInputControls", () => ({
  ChatInputControls: () => null,
}));
vi.mock("@/components/chat/TokenBar", () => ({ TokenBar: () => null }));
vi.mock("@/components/chat/AttachmentsList", () => ({
  AttachmentsList: () => null,
}));
vi.mock("@/components/chat/SignInToChatNotice", () => ({
  SignInToChatNotice: () => null,
}));

/**
 * A stand-in for main's queue: the same list the real store keeps, so the
 * composer is exercised against authoritative-list semantics rather than
 * against its own optimistic guess.
 */
const mainQueue: { id: string; text: string; ts: number }[] = [];
const interject = vi.fn(async (_chatId: number, id: string, text: string) => {
  mainQueue.push({ id, text, ts: Date.now() });
  return { ok: true, pending: [...mainQueue] };
});
const cancel = vi.fn(async (_chatId: number, id: string) => {
  const at = mainQueue.findIndex((m) => m.id === id);
  if (at >= 0) mainQueue.splice(at, 1);
  return { ok: at >= 0, pending: [...mainQueue] };
});

vi.mock("@/ipc/ipc_client", () => ({
  IpcClient: {
    getInstance: () => ({
      cancelChatStream: vi.fn(),
      // SimpleChatInput mounts useLiveTurnTokenUsage → subscribes here.
      onTokenUsage: () => () => {},
      interjectUserMessage: interject,
      cancelUserInterjection: cancel,
      listUserInterjections: async () => [...mainQueue],
      onUserInterjections: () => () => {},
    }),
  },
}));

import { SimpleChatInput } from "@/components/SimpleChatInput";

describe("chat input — mid-turn messages while streaming", () => {
  beforeEach(() => {
    mainQueue.length = 0;
    interject.mockClear();
    cancel.mockClear();
    const { store } = renderWithProviders(<div />);
    store.set(isStreamingByIdAtom, new Map([[CHAT_ID, true]]));
    store.set(chatInputValueAtom, "");
    store.set(pendingInterjectionsByChatIdAtom, new Map());
  });

  it("keeps the textarea enabled and records the message over IPC while streaming", async () => {
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

    expect(interject).toHaveBeenCalledWith(
      CHAT_ID,
      expect.any(String),
      "do this next",
    );
    // The box clears immediately; the chip appears once main answers.
    expect(store.get(chatInputValueAtom)).toBe("");
    await waitFor(() => {
      expect(
        store.get(pendingInterjectionsByChatIdAtom).get(CHAT_ID)?.[0]?.text,
      ).toBe("do this next");
    });
    // The label names where it is going — the RUNNING turn, not the next one.
    expect(screen.getByText(/Sending to the running turn/)).toBeInTheDocument();
  });

  it("appends a second message instead of silently rejecting it", async () => {
    const { store } = renderWithProviders(
      <SimpleChatInput chatId={CHAT_ID} onSubmit={() => {}} />,
    );
    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
    for (const text of ["first", "second"]) {
      act(() => {
        fireEvent.change(textarea, { target: { value: text } });
      });
      act(() => {
        fireEvent.keyDown(textarea, { key: "Enter" });
      });
      // eslint-disable-next-line no-await-in-loop
      await waitFor(() =>
        expect(mainQueue.some((m) => m.text === text)).toBe(true),
      );
    }
    await waitFor(() => {
      const pending = store.get(pendingInterjectionsByChatIdAtom).get(CHAT_ID);
      // ORDER MATTERS: a correction that followed a request has to read in the
      // order it was typed, or a recency-biased model acts on the last line only.
      expect(pending?.map((m) => m.text)).toEqual(["first", "second"]);
    });
    expect(
      screen.getByText(/Sending 2 messages to the running turn/),
    ).toBeInTheDocument();
  });

  it("swaps Send for Stop while streaming — never both", () => {
    renderWithProviders(
      <SimpleChatInput chatId={CHAT_ID} onSubmit={() => {}} />,
    );
    expect(
      screen.getByTitle(
        "Stop generation (Enter sends your message to the running turn)",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByTitle("Send")).not.toBeInTheDocument();
  });

  it("shows Send (and no Stop) when not streaming", () => {
    const { store } = renderWithProviders(
      <SimpleChatInput chatId={CHAT_ID} onSubmit={() => {}} />,
    );
    act(() => {
      store.set(isStreamingByIdAtom, new Map([[CHAT_ID, false]]));
    });
    expect(screen.getByTitle("Send")).toBeInTheDocument();
    expect(
      screen.queryByTitle(
        "Stop generation (Enter sends your message to the running turn)",
      ),
    ).not.toBeInTheDocument();
  });

  it("cancels one pending message via its × control, leaving the rest", async () => {
    const { store } = renderWithProviders(
      <SimpleChatInput chatId={CHAT_ID} onSubmit={() => {}} />,
    );
    act(() => {
      store.set(
        pendingInterjectionsByChatIdAtom,
        new Map([
          [
            CHAT_ID,
            [
              { id: "a", text: "keep me", ts: 1 },
              { id: "b", text: "drop me", ts: 2 },
            ],
          ],
        ]),
      );
    });
    mainQueue.push(
      { id: "a", text: "keep me", ts: 1 },
      { id: "b", text: "drop me", ts: 2 },
    );
    const rows = screen.getAllByTitle("Cancel this message");
    expect(rows).toHaveLength(2);
    fireEvent.click(rows[1]!);
    await waitFor(() => {
      expect(
        store
          .get(pendingInterjectionsByChatIdAtom)
          .get(CHAT_ID)
          ?.map((m) => m.text),
      ).toEqual(["keep me"]);
    });
    expect(cancel).toHaveBeenCalledWith(CHAT_ID, "b");
  });
});
