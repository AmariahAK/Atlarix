/**
 * Evicting a cold chat's renderer state.
 *
 * `clearChatAtomsForChat` existed for the v12 delete-path leak, and both of its
 * callers were TERMINAL — a deleted session and a brand-new one — so nothing ever
 * exercised the case where the chat comes back. That is the case these tests pin:
 * the state goes, the ids the user is looking at do NOT, and the chat is recorded
 * as evicted so activation knows to reload it rather than trusting whatever a
 * background stream happens to have put back.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { getDefaultStore } from "jotai";
import type { Message } from "@/ipc/ipc_types";
import {
  activeChatIdAtom,
  chatMessagesByIdAtom,
  completedStreamThreadByAssistantMessageIdAtom,
  evictedChatIdsAtom,
  interleavedDisplayContentByMessageIdAtom,
  selectedChatIdAtom,
  streamThreadByChatIdAtom,
} from "@/atoms/chatAtoms";
import {
  clearChatAtomsForChat,
  isChatEvicted,
  markChatRehydrated,
} from "@/lib/chat/clear-chat-atoms";

const COLD = -101;
const HOT = -102;

const msg = (id: number): Message =>
  ({ id, role: "assistant", content: `m${id}` }) as Message;

function seedChat(chatId: number, messageIds: number[]) {
  const store = getDefaultStore();
  store.set(chatMessagesByIdAtom, (prev) =>
    new Map(prev).set(chatId, messageIds.map(msg)),
  );
  store.set(streamThreadByChatIdAtom, (prev) =>
    new Map(prev).set(chatId, [{ kind: "text", text: "thinking" }] as never),
  );
  for (const id of messageIds) {
    store.set(completedStreamThreadByAssistantMessageIdAtom, (prev) => ({
      ...prev,
      [id]: [{ kind: "text", text: "tool card" }] as never,
    }));
    store.set(interleavedDisplayContentByMessageIdAtom, (prev) => ({
      ...prev,
      [id]: "rendered",
    }));
  }
}

beforeEach(() => {
  const store = getDefaultStore();
  store.set(chatMessagesByIdAtom, new Map());
  store.set(streamThreadByChatIdAtom, new Map());
  store.set(completedStreamThreadByAssistantMessageIdAtom, {});
  store.set(interleavedDisplayContentByMessageIdAtom, {});
  store.set(evictedChatIdsAtom, new Set());
  store.set(activeChatIdAtom, null);
  store.set(selectedChatIdAtom, null);
});

describe("evicting a cold chat", () => {
  it("frees its messages, stream thread and per-message display state", () => {
    const store = getDefaultStore();
    seedChat(COLD, [1, 2]);
    seedChat(HOT, [3]);

    clearChatAtomsForChat(COLD, { reason: "evicted" });

    expect(store.get(chatMessagesByIdAtom).has(COLD)).toBe(false);
    expect(store.get(streamThreadByChatIdAtom).has(COLD)).toBe(false);
    // The per-MESSAGE maps are the ones that actually hold the bulk — frozen tool
    // cards and rendered bodies for every turn of the session.
    expect(store.get(completedStreamThreadByAssistantMessageIdAtom)[1]).toBeUndefined();
    expect(store.get(completedStreamThreadByAssistantMessageIdAtom)[2]).toBeUndefined();
    expect(store.get(interleavedDisplayContentByMessageIdAtom)[1]).toBeUndefined();

    // The chat still on screen is untouched — eviction is per chat, and message
    // ids are global, so a careless implementation would take both.
    expect(store.get(chatMessagesByIdAtom).has(HOT)).toBe(true);
    expect(store.get(completedStreamThreadByAssistantMessageIdAtom)[3]).toBeDefined();
  });

  // The reason `reason` exists. Both original callers were terminal, so nulling
  // the ids was free; for a merely-inactive chat it would blank the session the
  // user is actually looking at.
  it("leaves the active and selected ids alone", () => {
    const store = getDefaultStore();
    seedChat(COLD, [1]);
    store.set(activeChatIdAtom, HOT);
    store.set(selectedChatIdAtom, HOT);

    clearChatAtomsForChat(COLD, { reason: "evicted" });

    expect(store.get(activeChatIdAtom)).toBe(HOT);
    expect(store.get(selectedChatIdAtom)).toBe(HOT);
  });

  it("records the eviction, and a real reload clears it", () => {
    seedChat(COLD, [1]);
    expect(isChatEvicted(COLD)).toBe(false);

    clearChatAtomsForChat(COLD, { reason: "evicted" });
    expect(isChatEvicted(COLD)).toBe(true);

    markChatRehydrated(COLD);
    expect(isChatEvicted(COLD)).toBe(false);
  });

  /**
   * Why membership is tracked at all: a background stream repopulates the
   * MESSAGES on its own, because main sends the whole list with every chunk. It
   * does not rebuild the per-message display atoms — only a full session load
   * runs `replaceDisplayHydrationForChat`. So "the messages are back" is not
   * "this chat is whole", and activation must not be fooled by it.
   */
  it("stays evicted when a background stream puts the messages back", () => {
    const store = getDefaultStore();
    seedChat(COLD, [1]);
    clearChatAtomsForChat(COLD, { reason: "evicted" });

    // A chunk arrives for the cold chat and repopulates its message list.
    store.set(chatMessagesByIdAtom, (prev) => new Map(prev).set(COLD, [msg(1)]));

    expect(store.get(chatMessagesByIdAtom).get(COLD)).toHaveLength(1);
    // …but its tool cards are still gone, so it must still be reloaded.
    expect(store.get(completedStreamThreadByAssistantMessageIdAtom)[1]).toBeUndefined();
    expect(isChatEvicted(COLD)).toBe(true);
  });
});

describe("deleting a chat still behaves as it did", () => {
  it("nulls the ids when the deleted chat was the active one", () => {
    const store = getDefaultStore();
    seedChat(COLD, [1]);
    store.set(activeChatIdAtom, COLD);
    store.set(selectedChatIdAtom, COLD);

    clearChatAtomsForChat(COLD);

    expect(store.get(activeChatIdAtom)).toBeNull();
    expect(store.get(selectedChatIdAtom)).toBeNull();
  });

  // A deleted chat can never come back, so leaving it in the evicted set would be
  // a slow leak of exactly the kind this function exists to prevent.
  it("does not leave a deleted chat marked as evicted", () => {
    seedChat(COLD, [1]);
    clearChatAtomsForChat(COLD, { reason: "evicted" });
    expect(isChatEvicted(COLD)).toBe(true);

    clearChatAtomsForChat(COLD);
    expect(isChatEvicted(COLD)).toBe(false);
  });
});
