/**
 * v11.1: stream-failure banner renders pinned to the BOTTOM slot (above the
 * chat input) — not at the top of the page — and Retry restreams via
 * continueAfterQuestions.
 */

import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, fireEvent, screen } from "@testing-library/react";
import { chatErrorByIdAtom } from "@/atoms/chatAtoms";
import {
  COMPASS_REACHABILITY_ERROR,
  autoConsentRequiredUserMessage,
  coreExhaustedUserMessage,
  freeUsageLimitUserMessage,
} from "@/shared/billing_copy";
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

  /**
   * The Retry row used to render under EVERY error, including the one error it cannot
   * possibly fix. On an exhausted wallet it re-sent the same request against the same
   * empty balance — guaranteed to fail identically — while duplicating the credit card's
   * own "Choose another model" button in its hint text.
   *
   * The pair below is the point: suppressed for an exhausted balance, KEPT for a
   * reachability failure. Asserting only the first would let "hide Retry whenever the
   * box has its own buttons" pass, which would take Retry away from the transient
   * failure that most deserves it.
   */
  it("hides Retry when the balance is used up — retrying cannot change that", () => {
    const { store } = renderWithProviders(
      <SimpleInlineChat chatId={CHAT_ID} onSendMessage={() => {}} />,
    );
    act(() => {
      store.set(
        chatErrorByIdAtom,
        new Map([[CHAT_ID, coreExhaustedUserMessage(924)]]),
      );
    });

    expect(screen.getByTestId("chat-error-bottom")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    expect(
      screen.queryByText(/switch models using the selector below/i),
    ).toBeNull();
    // And the figure the proxy sent reaches the user.
    expect(screen.getByText(/\$9\.24/)).toBeTruthy();
  });

  it("free Auto's limit leads with credit and your own key; Pro comes last", () => {
    const { store } = renderWithProviders(
      <SimpleInlineChat chatId={CHAT_ID} onSendMessage={() => {}} />,
    );
    act(() => {
      store.set(chatErrorByIdAtom, new Map([[CHAT_ID, freeUsageLimitUserMessage(3600)]]));
    });

    const actions = screen.getByTestId("free-limit-actions");
    const labels = Array.from(actions.children).map((el) => el.textContent?.trim());
    expect(labels).toEqual(["Add credit", "Use your own key", "Upgrade to Pro"]);
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });

  it("KEEPS Retry when Core was merely unreachable — that one is transient", () => {
    const { store } = renderWithProviders(
      <SimpleInlineChat chatId={CHAT_ID} onSendMessage={() => {}} />,
    );
    act(() => {
      store.set(
        chatErrorByIdAtom,
        new Map([[CHAT_ID, COMPASS_REACHABILITY_ERROR]]),
      );
    });

    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
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

  /**
   * Reported 2026-09-25: after OK-ing free Auto the user had to send the same
   * message again. Accepting now records the consent FIRST (main reads it when
   * it builds the request) and then re-runs the refused turn.
   */
  it("accepting free-Auto consent saves it, then re-runs the turn", async () => {
    // Saving settings runs the telemetry opt-out, which touches localStorage —
    // and jsdom's stub here has no removeItem.
    const mem = new Map<string, string>();
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: {
        getItem: (k: string) => mem.get(k) ?? null,
        setItem: (k: string, v: string) => void mem.set(k, String(v)),
        removeItem: (k: string) => void mem.delete(k),
        clear: () => mem.clear(),
        key: (i: number) => Array.from(mem.keys())[i] ?? null,
        get length() {
          return mem.size;
        },
      },
    });
    fakeIpc.setUserSettings.mockClear();
    const order: string[] = [];
    fakeIpc.setUserSettings.mockImplementation(async (s: object) => {
      order.push("save");
      return s;
    });
    streamMessage.mockImplementation(() => order.push("retry"));
    const { store } = renderWithProviders(
      <SimpleInlineChat chatId={CHAT_ID} onSendMessage={() => {}} />,
    );
    act(() => {
      store.set(
        chatErrorByIdAtom,
        new Map([[CHAT_ID, autoConsentRequiredUserMessage()]]),
      );
    });

    fireEvent.click(screen.getByTestId("auto-review-consent"));
    await act(async () => {
      fireEvent.click(await screen.findByRole("button", { name: "Use Atlarix Auto" }));
    });

    expect(fakeIpc.setUserSettings).toHaveBeenCalledWith(
      expect.objectContaining({ atlarixAutoConsentAt: expect.any(String) }),
    );
    expect(streamMessage).toHaveBeenCalledWith({
      prompt: "",
      chatId: CHAT_ID,
      continueAfterQuestions: true,
    });
    expect(order).toEqual(["save", "retry"]);
    expect(store.get(chatErrorByIdAtom).get(CHAT_ID)).toBeUndefined();
    streamMessage.mockImplementation(() => undefined);
  });
});
