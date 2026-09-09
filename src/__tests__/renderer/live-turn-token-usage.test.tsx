import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { getDefaultStore } from "jotai";
import {
  liveTurnUsageByChatIdAtom,
  liveTurnToolBucketsByChatIdAtom,
  isStreamingByIdAtom,
} from "@/atoms/chatAtoms";

// Capture the onTokenUsage handler the hook registers so the test can drive
// backend emits. This is the whole point of the hook living in an always-mounted
// component: the meter must update from these events WITHOUT any popover mounted.
type Buckets = {
  filesRead: number;
  searchResults: number;
  otherToolOutput: number;
};
type Emit = {
  chatId: number;
  inputTokens: number | null;
  outputTokens: number;
  toolBuckets?: Buckets;
};
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

function readBuckets() {
  return getDefaultStore().get(liveTurnToolBucketsByChatIdAtom)[CHAT_ID];
}

describe("useLiveTurnTokenUsage (live meter wiring)", () => {
  beforeEach(() => {
    const store = getDefaultStore();
    store.set(liveTurnUsageByChatIdAtom, {});
    store.set(liveTurnToolBucketsByChatIdAtom, {});
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

/**
 * The breakdown rows used to sit frozen until the turn ended, because mid-turn
 * the tool results exist only in main — they are not stamped onto the assistant
 * row's `modelContent` until finalize, so the count-tokens IPC cannot see them
 * no matter how often it is re-queried. Main pushes the attribution instead.
 */
describe("live per-tool buckets", () => {
  beforeEach(() => {
    const store = getDefaultStore();
    store.set(liveTurnUsageByChatIdAtom, {});
    store.set(liveTurnToolBucketsByChatIdAtom, {});
    store.set(isStreamingByIdAtom, new Map());
    tokenHandler = null;
  });

  it("climbs as steps land", () => {
    renderHook(() => useLiveTurnTokenUsage(CHAT_ID));
    tokenHandler!({
      chatId: CHAT_ID,
      inputTokens: 1_000,
      outputTokens: 10,
      toolBuckets: { filesRead: 800, searchResults: 0, otherToolOutput: 0 },
    });
    expect(readBuckets()).toEqual({
      filesRead: 800,
      searchResults: 0,
      otherToolOutput: 0,
    });

    tokenHandler!({
      chatId: CHAT_ID,
      inputTokens: 2_000,
      outputTokens: 20,
      toolBuckets: { filesRead: 800, searchResults: 350, otherToolOutput: 0 },
    });
    expect(readBuckets()).toEqual({
      filesRead: 800,
      searchResults: 350,
      otherToolOutput: 0,
    });
  });

  it("assigns the running total rather than accumulating it", () => {
    // The emit is cumulative for the turn, so a re-delivered or duplicated event
    // must not double the meter.
    renderHook(() => useLiveTurnTokenUsage(CHAT_ID));
    const emit = {
      chatId: CHAT_ID,
      inputTokens: 1_000,
      outputTokens: 10,
      toolBuckets: { filesRead: 500, searchResults: 0, otherToolOutput: 0 },
    };
    tokenHandler!(emit);
    tokenHandler!(emit);
    expect(readBuckets()!.filesRead).toBe(500);
  });

  it("a throttled estimate (no buckets) leaves the last attribution intact", () => {
    renderHook(() => useLiveTurnTokenUsage(CHAT_ID));
    tokenHandler!({
      chatId: CHAT_ID,
      inputTokens: 1_000,
      outputTokens: 10,
      toolBuckets: { filesRead: 700, searchResults: 0, otherToolOutput: 0 },
    });
    tokenHandler!({ chatId: CHAT_ID, inputTokens: null, outputTokens: 90 });
    expect(readBuckets()!.filesRead).toBe(700);
  });

  it("RESETS at the start of a new turn", () => {
    // Unlike the occupancy meter, which collapses the previous turn into a
    // baseline: last turn's tool reads are already inside the settled
    // count-tokens numbers, so carrying them would double-count every file for
    // the rest of the session.
    const store = getDefaultStore();
    store.set(liveTurnToolBucketsByChatIdAtom, {
      [CHAT_ID]: { filesRead: 9_000, searchResults: 100, otherToolOutput: 5 },
    });
    const { rerender } = renderHook(
      ({ streaming }) => {
        store.set(isStreamingByIdAtom, new Map([[CHAT_ID, streaming]]));
        return useLiveTurnTokenUsage(CHAT_ID);
      },
      { initialProps: { streaming: false } },
    );
    rerender({ streaming: true });
    expect(readBuckets()).toBeUndefined();
  });

  it("ignores buckets for another chat", () => {
    renderHook(() => useLiveTurnTokenUsage(CHAT_ID));
    tokenHandler!({
      chatId: 9999,
      inputTokens: 1,
      outputTokens: 1,
      toolBuckets: { filesRead: 1, searchResults: 1, otherToolOutput: 1 },
    });
    expect(readBuckets()).toBeUndefined();
  });
});
