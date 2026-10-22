/**
 * The app's "How is Atlarix doing this session?" (owner, 2026-10-22): asked of
 * everyone after 6 turns in a session, once, then "What should we improve?";
 * the quiet period after an answer is shared with the CLI and the editors.
 */
import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { getDefaultStore } from "jotai";
import { makeFakeIpc, renderWithProviders } from "./helpers";
import { chatMessagesByIdAtom, isStreamingByIdAtom } from "@/atoms/chatAtoms";

const fakeIpc = makeFakeIpc() as unknown as Record<string, ReturnType<typeof vi.fn>>;
vi.mock("@/ipc/ipc_client", () => ({ IpcClient: { getInstance: () => fakeIpc } }));

import { openFeedbackFor, SessionRatingCard } from "@/components/chat/SessionRatingCard";

const store = getDefaultStore();
let nextId = 1;

/** `n` user turns in the chat, then a turn ending. */
async function turnsEnd(chatId: number, n: number) {
  const msgs = Array.from({ length: n }, () => [
    { id: nextId++, role: "user", content: "x" },
    { id: nextId++, role: "assistant", content: "y" },
  ]).flat();
  await act(async () => {
    store.set(chatMessagesByIdAtom, new Map([[chatId, msgs as never]]));
    store.set(isStreamingByIdAtom, new Map([[chatId, true]]));
  });
  await act(async () => store.set(isStreamingByIdAtom, new Map([[chatId, false]])));
}

beforeEach(() => {
  fakeIpc.getFeedbackState = vi.fn(async () => ({ askedAt: null, force: false }));
  fakeIpc.rateSession = vi.fn(async () => ({ ok: true }));
  fakeIpc.sendFeedback = vi.fn(async () => ({ ok: true }));
});

describe("the app's session rating", () => {
  it("not before 6 turns", async () => {
    renderWithProviders(<SessionRatingCard chatId={101} composerEmpty />);
    await turnsEnd(101, 5);
    await waitFor(() => expect(fakeIpc.getFeedbackState).toHaveBeenCalled());
    expect(screen.queryByText("How is Atlarix doing this session?")).toBeNull();
  });

  it("after 6: a rating, then what to improve, with nothing but the session's shape", async () => {
    renderWithProviders(<SessionRatingCard chatId={102} composerEmpty />);
    await turnsEnd(102, 6);
    expect(await screen.findByText("How is Atlarix doing this session?")).toBeTruthy();
    expect(screen.getByText(/Never your code or prompts/)).toBeTruthy();
    await act(async () => fireEvent.click(screen.getByText("3 Good")));
    expect(fakeIpc.rateSession).toHaveBeenCalledWith(3, expect.objectContaining({ turns: 6 }));
    const about = fakeIpc.rateSession.mock.calls[0]![1] as Record<string, unknown>;
    expect(Object.keys(about).sort()).toEqual(["effort", "mode", "model", "provider", "startedAt", "turns"]);
    expect(await screen.findByText("What should we improve?")).toBeTruthy();
    const box = document.querySelector("textarea")!;
    await act(async () => fireEvent.change(box, { target: { value: "the diff view is slow" } }));
    await act(async () => fireEvent.click(screen.getByText("Send")));
    expect(fakeIpc.sendFeedback).toHaveBeenCalledWith("the diff view is slow", expect.any(Object));
  });

  it("keys 1-3 answer and 0 dismisses while the composer is empty", async () => {
    renderWithProviders(<SessionRatingCard chatId={103} composerEmpty />);
    await turnsEnd(103, 6);
    await screen.findByText("How is Atlarix doing this session?");
    await act(async () => fireEvent.keyDown(window, { key: "0" }));
    expect(fakeIpc.rateSession).toHaveBeenCalledWith(0, expect.any(Object));
    expect(screen.queryByText("How is Atlarix doing this session?")).toBeNull();
    expect(fakeIpc.sendFeedback).not.toHaveBeenCalled();
  });

  it("waits out the quiet period another surface started", async () => {
    fakeIpc.getFeedbackState = vi.fn(async () => ({ askedAt: Date.now() - 60_000, force: false }));
    renderWithProviders(<SessionRatingCard chatId={104} composerEmpty />);
    await turnsEnd(104, 8);
    await waitFor(() => expect(fakeIpc.getFeedbackState).toHaveBeenCalled());
    expect(screen.queryByText("How is Atlarix doing this session?")).toBeNull();
  });

  it("/feedback with text sends it; a failed send keeps the words", async () => {
    fakeIpc.sendFeedback = vi.fn(async () => ({ ok: false }));
    renderWithProviders(<SessionRatingCard chatId={105} composerEmpty />);
    await act(async () => openFeedbackFor(105, { rating: 2, body: "too many popups" }));
    expect(fakeIpc.rateSession).toHaveBeenCalledWith(2, expect.any(Object));
    expect(fakeIpc.sendFeedback).toHaveBeenCalledWith("too many popups", expect.any(Object));
    expect(await screen.findByText("Couldn't send that. Try again later.")).toBeTruthy();
    expect((document.querySelector("textarea") as HTMLTextAreaElement).value).toBe("too many popups");
  });
});
