/**
 * `useEvictColdChatState` — the cold rule itself.
 *
 * Cold means **not the visually-active chat AND not streaming**. Being open in a
 * tab does not protect a chat: with two sessions open and the second on screen,
 * the first is cold. The two things worth pinning are the boundaries — that
 * nothing is evicted on MOUNT (an effect acting on window open with no user
 * action is the shape of the v14.34.0 bug), and that a streaming chat is never
 * touched however long you look away.
 */
import { describe, expect, it, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { getDefaultStore } from "jotai";
import type { Message } from "@/ipc/ipc_types";
import {
  activeChatIdAtom,
  chatMessagesByIdAtom,
  evictedChatIdsAtom,
  isStreamingByIdAtom,
} from "@/atoms/chatAtoms";
import { isChatEvicted } from "@/lib/chat/clear-chat-atoms";
import { useEvictColdChatState } from "@/hooks/useEvictColdChatState";

const A = -201;
const B = -202;

const msg = (id: number): Message =>
  ({ id, role: "assistant", content: `m${id}` }) as Message;

function seed(chatId: number) {
  getDefaultStore().set(chatMessagesByIdAtom, (prev) =>
    new Map(prev).set(chatId, [msg(chatId)]),
  );
}

function activate(chatId: number | null) {
  act(() => {
    getDefaultStore().set(activeChatIdAtom, chatId);
  });
}

beforeEach(() => {
  const store = getDefaultStore();
  store.set(chatMessagesByIdAtom, new Map());
  store.set(isStreamingByIdAtom, new Map());
  store.set(activeChatIdAtom, null);
  // These tests share jotai's DEFAULT store (that is what the hook writes to), so
  // the eviction record survives between them unless it is reset here.
  store.set(evictedChatIdsAtom, new Set());
});

describe("useEvictColdChatState", () => {
  it("evicts the chat you switched AWAY from", () => {
    const store = getDefaultStore();
    seed(A);
    seed(B);
    store.set(activeChatIdAtom, A);

    renderHook(() => useEvictColdChatState());
    activate(B);

    expect(store.get(chatMessagesByIdAtom).has(A)).toBe(false);
    expect(isChatEvicted(A)).toBe(true);
    // The one you switched TO is obviously kept.
    expect(store.get(chatMessagesByIdAtom).has(B)).toBe(true);
  });

  // A chat open in another tab is still cold. This is the owner's rule, and the
  // reason the hook does not consult `openChatTabsAtom` at all.
  it("does not spare a chat merely because it is still open in a tab", () => {
    const store = getDefaultStore();
    seed(A);
    store.set(activeChatIdAtom, A);
    renderHook(() => useEvictColdChatState());
    activate(B);
    expect(store.get(chatMessagesByIdAtom).has(A)).toBe(false);
  });

  it("never evicts a STREAMING chat, however long you look away", () => {
    const store = getDefaultStore();
    seed(A);
    store.set(activeChatIdAtom, A);
    store.set(isStreamingByIdAtom, new Map([[A, true]]));

    renderHook(() => useEvictColdChatState());
    activate(B);

    // Its turn is still writing into these maps, and a parked turn can resume
    // into them.
    expect(store.get(chatMessagesByIdAtom).has(A)).toBe(true);
    expect(isChatEvicted(A)).toBe(false);
  });

  it("evicts nothing on mount", () => {
    const store = getDefaultStore();
    seed(A);
    store.set(activeChatIdAtom, A);

    renderHook(() => useEvictColdChatState());

    // No transition has happened. An effect that acted here would be changing
    // state because a window opened, with no user action behind it.
    expect(store.get(chatMessagesByIdAtom).has(A)).toBe(true);
    expect(isChatEvicted(A)).toBe(false);
  });

  it("evicts nothing when the active chat is re-set to the same id", () => {
    const store = getDefaultStore();
    seed(A);
    store.set(activeChatIdAtom, A);
    renderHook(() => useEvictColdChatState());

    activate(A);
    expect(store.get(chatMessagesByIdAtom).has(A)).toBe(true);
  });

  // A streaming tick replaces the whole `isStreamingByIdAtom` map, so the effect
  // re-runs constantly. It must not treat that as a switch.
  it("is not confused by streaming-map churn while the active chat is unchanged", () => {
    const store = getDefaultStore();
    seed(A);
    seed(B);
    store.set(activeChatIdAtom, B);
    renderHook(() => useEvictColdChatState());

    for (let i = 0; i < 5; i++) {
      act(() => {
        store.set(isStreamingByIdAtom, new Map([[B, i % 2 === 0]]));
      });
    }

    expect(store.get(chatMessagesByIdAtom).has(A)).toBe(true);
    expect(store.get(chatMessagesByIdAtom).has(B)).toBe(true);
  });
});
