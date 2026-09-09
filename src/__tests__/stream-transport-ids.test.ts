/**
 * v12 3.1/3.8: ephemeral message ids are collision-free (monotonic counter,
 * not Date.now()) and editing a user message drops its stale per-message
 * derived state (displaySnapshot / modelContent).
 */

import { describe, expect, it } from "vitest";
import {
  createStreamTransport,
  appendTransportMessage,
  getStreamTransport,
  editTransportUserMessage,
  setTransportMessageDisplaySnapshot,
  deleteStreamTransport,
} from "@/lib/chat/stream-transport";
import type { DisplaySnapshotV1 } from "@/lib/chat/display-snapshot";

describe("ephemeral message ids (3.1)", () => {
  it("assigns unique ids under rapid same-millisecond inserts", () => {
    const chatId = createStreamTransport(1);
    for (let i = 0; i < 50; i++) {
      appendTransportMessage(chatId, { role: "user", content: `m${i}` });
    }
    const ids = (getStreamTransport(chatId)?.messages ?? []).map((m) => m.id);
    expect(ids.length).toBe(50);
    expect(new Set(ids).size).toBe(50); // Date.now() ids collided here
    // Monotonic: strictly increasing.
    for (let i = 1; i < ids.length; i++) {
      expect(ids[i]).toBeGreaterThan(ids[i - 1]);
    }
    deleteStreamTransport(chatId);
  });
});

describe("edit clears stale derived state (3.8)", () => {
  it("drops displaySnapshot from the rewritten message", () => {
    const chatId = createStreamTransport(1);
    appendTransportMessage(chatId, { role: "user", content: "original" });
    const msg = getStreamTransport(chatId)!.messages[0]!;
    const snapshot = { v: 1, items: [] } as unknown as DisplaySnapshotV1;
    expect(setTransportMessageDisplaySnapshot(chatId, msg.id, snapshot)).toBe(
      true,
    );
    expect(
      getStreamTransport(chatId)!.messages[0]!.displaySnapshot,
    ).toBeTruthy();

    expect(editTransportUserMessage(chatId, msg.id, "edited")).toBe(true);
    const edited = getStreamTransport(chatId)!.messages[0]!;
    expect(edited.content).toBe("edited");
    expect(edited.displaySnapshot).toBeUndefined(); // stale snapshot gone
    deleteStreamTransport(chatId);
  });

  it("truncates the tail after the edited message", () => {
    const chatId = createStreamTransport(1);
    appendTransportMessage(chatId, { role: "user", content: "first" });
    appendTransportMessage(chatId, { role: "assistant", content: "reply" });
    appendTransportMessage(chatId, { role: "user", content: "second" });
    const first = getStreamTransport(chatId)!.messages[0]!;
    expect(editTransportUserMessage(chatId, first.id, "rewritten")).toBe(true);
    const msgs = getStreamTransport(chatId)!.messages;
    expect(msgs.length).toBe(1);
    expect(msgs[0]!.content).toBe("rewritten");
    deleteStreamTransport(chatId);
  });
});
