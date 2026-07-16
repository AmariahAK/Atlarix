import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { getDefaultStore } from "jotai";
import {
  liveTurnUsageByChatIdAtom,
  isStreamingByIdAtom,
} from "@/atoms/chatAtoms";

// Capture the onTokenUsage handler the hook registers so the test can drive
// backend emits. This is the whole point of the hook living in an always-mounted
// component: the meter must update from these events WITHOUT any popover mounted.
type Emit = { chatId: number; inputTokens: number | null; outputTokens: number };
let tokenHandler: ((p: Emit) => void) | null = null;
const onTokenUsage = vi.fn((h: (p: Emit) => void) => {
  tokenHandler = h;
  return () => {
    tokenHandler = null;
  };
});

vi.mock("@/ipc/ipc_client", () => ({
  IpcClient: {
    getInstance: () => ({ onTokenUsage }),
  },
}));

import { useLiveTurnTokenUsage } from "@/hooks/useLiveTurnTokenUsage";

const CHAT_ID = 4242;

function read() {
  return getDefaultStore().get(liveTurnUsageByChatIdAtom)[CHAT_ID];
}

describe("useLiveTurnTokenUsage (live meter wiring)", () => {
  beforeEach(() => {
    const store = getDefaultStore();
    store.set(liveTurnUsageByChatIdAtom, {});
    store.set(isStreamingByIdAtom, new Map());
    tokenHandler = null;
  });

  it("updates the shared atom from token-usage events (no popover involved)", () => {
    renderHook(() => useLiveTurnTokenUsage(CHAT_ID));
    expect(tokenHandler).toBeTypeOf("function");

    // Streaming estimate before any real usage → output tracks the estimate.
    tokenHandler!({ chatId: CHAT_ID, inputTokens: null, outputTokens: 120 });
    expect(read()).toEqual({ input: null, output: 120 });

    // Real per-step checkpoint snaps to provider truth.
    tokenHandler!({ chatId: CHAT_ID, inputTokens: 10_000, outputTokens: 200 });
    expect(read()).toEqual({ input: 10_000, output: 200 });

    // Further estimates keep the meter climbing after the checkpoint (the freeze
    // bug fix): output = confirmed step output + delta since the checkpoint.
    tokenHandler!({ chatId: CHAT_ID, inputTokens: null, outputTokens: 320 });
    expect(read()).toEqual({ input: 10_000, output: 200 + (320 - 120) });
  });

  it("ignores events for other chats", () => {
    renderHook(() => useLiveTurnTokenUsage(CHAT_ID));
    tokenHandler!({ chatId: 9999, inputTokens: 5_000, outputTokens: 50 });
    expect(read()).toBeUndefined();
  });

  it("holds occupancy across turns instead of dropping to the estimate", () => {
    const store = getDefaultStore();
    // Prior turn ended at a real occupancy of 10_000 + 400.
    store.set(liveTurnUsageByChatIdAtom, {
      [CHAT_ID]: { input: 10_000, output: 400 },
    });
    const { rerender } = renderHook(
      ({ streaming }) => {
        store.set(isStreamingByIdAtom, new Map([[CHAT_ID, streaming]]));
        return useLiveTurnTokenUsage(CHAT_ID);
      },
      { initialProps: { streaming: false } },
    );

    // A new turn starts (rising edge): the resting occupancy collapses into the
    // input baseline and output zeroes — NO drop to a lower client estimate.
    rerender({ streaming: true });
    expect(read()).toEqual({ input: 10_400, output: 0 });
  });
});
