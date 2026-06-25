/**
 * A3 — the parked chip renders only when the turn parked (ended with background
 * work outstanding), shows accurate counts, and dismiss clears it.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { act, fireEvent, screen } from "@testing-library/react";
import { parkedWaitingByChatIdAtom } from "@/atoms/chatAtoms";
import { renderWithProviders } from "./helpers";
import { ParkedWaitingChip } from "@/components/chat/ParkedWaitingChip";

const CHAT_ID = 42;

describe("ParkedWaitingChip", () => {
  beforeEach(() => {
    const { store } = renderWithProviders(<div />);
    store.set(parkedWaitingByChatIdAtom, new Map());
  });

  it("renders nothing when the chat is not parked", () => {
    const { container } = renderWithProviders(<ParkedWaitingChip chatId={CHAT_ID} />);
    expect(container.textContent).toBe("");
  });

  it("shows both counts and the auto-resume reassurance when parked", () => {
    const { store } = renderWithProviders(<ParkedWaitingChip chatId={CHAT_ID} />);
    act(() => {
      store.set(
        parkedWaitingByChatIdAtom,
        new Map([[CHAT_ID, { commands: 2, subagents: 1, parkedAt: 0 }]]),
      );
    });
    const text = screen.getByText(/will resume automatically/i).textContent ?? "";
    expect(text).toContain("2 background tasks");
    expect(text).toContain("1 sub-agent");
  });

  it("singularizes one command and shows no sub-agents when zero", () => {
    const { store } = renderWithProviders(<ParkedWaitingChip chatId={CHAT_ID} />);
    act(() => {
      store.set(
        parkedWaitingByChatIdAtom,
        new Map([[CHAT_ID, { commands: 1, subagents: 0, parkedAt: 0 }]]),
      );
    });
    const text = screen.getByText(/will resume automatically/i).textContent ?? "";
    expect(text).toContain("1 background task");
    expect(text).not.toContain("sub-agent");
  });

  it("dismiss (×) clears the parked entry for this chat", () => {
    const { store } = renderWithProviders(<ParkedWaitingChip chatId={CHAT_ID} />);
    act(() => {
      store.set(
        parkedWaitingByChatIdAtom,
        new Map([[CHAT_ID, { commands: 0, subagents: 2, parkedAt: 0 }]]),
      );
    });
    expect(screen.getByText(/2 sub-agents/i)).toBeInTheDocument();
    fireEvent.click(screen.getByTitle(/stop showing this/i));
    expect(store.get(parkedWaitingByChatIdAtom).has(CHAT_ID)).toBe(false);
  });
});
