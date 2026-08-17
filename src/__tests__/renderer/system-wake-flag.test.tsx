/**
 * Every harness-started turn must be MARKED as one.
 *
 * `systemWake` is what lets main refuse a wake that would interrupt a live turn
 * or resurrect a stopped chat. A wake site that forgets the flag is invisible —
 * it works fine in one window and reintroduces the two-window runaway (84 stream
 * starts, 80 superseded aborts, a beachball) the moment a second one is open.
 *
 * So the flag is pinned at the dispatch boundary rather than trusted to review.
 */
import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { getDefaultStore } from "jotai";
import { makeFakeIpc, type FakeIpc } from "./helpers";
import { isStreamingByIdAtom } from "@/atoms/chatAtoms";

const fakeIpc = makeFakeIpc();
vi.mock("@/ipc/ipc_client", () => ({
  IpcClient: { getInstance: () => fakeIpc },
}));

const { useStreamChat } = await import("@/hooks/useStreamChat");

const CHAT = -28;

/** Mounts the hook and nothing else — the listeners are what is under test. */
function Host() {
  useStreamChat({ hasChatId: true });
  return null;
}

function mountHost() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <Host />
    </QueryClientProvider>,
  );
}

describe("the background-job auto-wake", () => {
  beforeEach(() => {
    (fakeIpc.streamMessage as ReturnType<typeof vi.fn>).mockClear();
    getDefaultStore().set(isStreamingByIdAtom, new Map());
  });
  afterEach(() => cleanup());

  it("dispatches with systemWake so main can refuse it", async () => {
    mountHost();
    await act(async () => {
      (fakeIpc as FakeIpc).emitBackgroundJobUpdate({
        chatId: CHAT,
        status: "finished",
        source: "command",
      });
      await Promise.resolve();
    });

    const calls = (fakeIpc.streamMessage as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    const opts = calls[calls.length - 1][1];
    expect(opts.chatId).toBe(CHAT);
    expect(opts.systemWake).toBe(true);
  });

  /**
   * The per-window guard still short-circuits locally when this window KNOWS the
   * chat is streaming. It is a cheap filter, not the decision — the point of the
   * fix is that main answers when this check cannot.
   */
  it("still skips locally when this window knows the chat is streaming", async () => {
    getDefaultStore().set(isStreamingByIdAtom, new Map([[CHAT, true]]));
    mountHost();
    await act(async () => {
      (fakeIpc as FakeIpc).emitBackgroundJobUpdate({
        chatId: CHAT,
        status: "finished",
        source: "command",
      });
      await Promise.resolve();
    });
    expect(fakeIpc.streamMessage).not.toHaveBeenCalled();
  });

  /**
   * The refusal has to land somewhere. `isStreaming` is set BEFORE the invoke, so
   * a window whose wake main refuses would otherwise sit at `isStreaming: true`
   * for that chat forever — a phantom spinner if it ever opened the chat, and a
   * local guard stuck permanently in the "don't wake" position.
   */
  it("clears its own isStreaming when main refuses the dispatch", async () => {
    mountHost();
    getDefaultStore().set(isStreamingByIdAtom, new Map([[CHAT, true]]));

    await act(async () => {
      (fakeIpc as FakeIpc).emitStreamDropped({
        chatId: CHAT,
        reason: "already-streaming",
      });
      await Promise.resolve();
    });

    expect(getDefaultStore().get(isStreamingByIdAtom).get(CHAT)).toBe(false);
  });

  it("leaves other chats alone when one is refused", async () => {
    mountHost();
    getDefaultStore().set(
      isStreamingByIdAtom,
      new Map([
        [CHAT, true],
        [-99, true],
      ]),
    );

    await act(async () => {
      (fakeIpc as FakeIpc).emitStreamDropped({
        chatId: CHAT,
        reason: "user-stopped",
      });
      await Promise.resolve();
    });

    expect(getDefaultStore().get(isStreamingByIdAtom).get(-99)).toBe(true);
  });

  it("ignores a job that is merely running", async () => {
    mountHost();
    await act(async () => {
      (fakeIpc as FakeIpc).emitBackgroundJobUpdate({
        chatId: CHAT,
        status: "running",
        source: "command",
      });
      await Promise.resolve();
    });
    expect(fakeIpc.streamMessage).not.toHaveBeenCalled();
  });
});
