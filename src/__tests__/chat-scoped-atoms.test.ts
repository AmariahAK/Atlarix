import { describe, expect, it } from "vitest";
import { createStore } from "jotai";
import type { Message } from "@/ipc/ipc_types";
import {
  chatMessagesByIdAtom,
  messagesForChatAtom,
  isStreamingByIdAtom,
  isStreamingForChatAtom,
} from "@/atoms/chatAtoms";

const msg = (id: number): Message =>
  ({ id, role: "user", content: `m${id}` }) as Message;

describe("per-chat scoped selector atoms (Fix 3.2 re-render fanout)", () => {
  it("messagesForChatAtom(1) does NOT notify when only chat 2's slice changes", () => {
    const store = createStore();
    const chat1 = [msg(1)];
    store.set(
      chatMessagesByIdAtom,
      new Map([
        [1, chat1],
        [2, [msg(2)]],
      ]),
    );

    let notifications = 0;
    const unsub = store.sub(messagesForChatAtom(1), () => {
      notifications++;
    });

    // Update ONLY chat 2 — clone the Map but keep chat 1's array reference.
    const next = new Map(store.get(chatMessagesByIdAtom));
    next.set(2, [msg(2), msg(3)]);
    store.set(chatMessagesByIdAtom, next);
    expect(notifications).toBe(0); // chat 1's slice ref unchanged → no re-render

    // Now update chat 1 → its consumer DOES notify.
    const next2 = new Map(store.get(chatMessagesByIdAtom));
    next2.set(1, [...chat1, msg(4)]);
    store.set(chatMessagesByIdAtom, next2);
    expect(notifications).toBe(1);

    unsub();
  });

  it("isStreamingForChatAtom(1) is stable when another chat flips streaming", () => {
    const store = createStore();
    store.set(isStreamingByIdAtom, new Map([[1, false]]));
    let notifications = 0;
    const unsub = store.sub(isStreamingForChatAtom(1), () => {
      notifications++;
    });

    // Chat 2 starts streaming — chat 1's flag is unchanged (false).
    const next = new Map(store.get(isStreamingByIdAtom));
    next.set(2, true);
    store.set(isStreamingByIdAtom, next);
    expect(notifications).toBe(0);
    expect(store.get(isStreamingForChatAtom(1))).toBe(false);

    // Chat 1 starts streaming → notifies.
    const next2 = new Map(store.get(isStreamingByIdAtom));
    next2.set(1, true);
    store.set(isStreamingByIdAtom, next2);
    expect(notifications).toBe(1);
    expect(store.get(isStreamingForChatAtom(1))).toBe(true);

    unsub();
  });
});
