/**
 * v12 3.1/3.8: ephemeral message ids are collision-free (monotonic counter,
 * not Date.now()) and editing a user message drops its stale per-message
 * derived state (displaySnapshot / modelContent).
 */

import { describe, expect, it } from "vitest";
import {
  createEphemeralWorkspaceChat,
  addEphemeralMessage,
  getEphemeralChat,
  editEphemeralUserMessage,
  setEphemeralMessageDisplaySnapshot,
  deleteEphemeralChat,
} from "@/lib/ephemeral-chat";
import type { DisplaySnapshotV1 } from "@/lib/chat/display-snapshot";

describe("ephemeral message ids (3.1)", () => {
  it("assigns unique ids under rapid same-millisecond inserts", () => {
    const chatId = createEphemeralWorkspaceChat(1);
    for (let i = 0; i < 50; i++) {
      addEphemeralMessage(chatId, { role: "user", content: `m${i}` });
    }
    const ids = (getEphemeralChat(chatId)?.messages ?? []).map((m) => m.id);
    expect(ids.length).toBe(50);
    expect(new Set(ids).size).toBe(50); // Date.now() ids collided here
    // Monotonic: strictly increasing.
    for (let i = 1; i < ids.length; i++) {
      expect(ids[i]).toBeGreaterThan(ids[i - 1]);
    }
    deleteEphemeralChat(chatId);
  });
});

describe("edit clears stale derived state (3.8)", () => {
  it("drops displaySnapshot from the rewritten message", () => {
    const chatId = createEphemeralWorkspaceChat(1);
    addEphemeralMessage(chatId, { role: "user", content: "original" });
    const msg = getEphemeralChat(chatId)!.messages[0]!;
    const snapshot = { v: 1, items: [] } as unknown as DisplaySnapshotV1;
    expect(setEphemeralMessageDisplaySnapshot(chatId, msg.id, snapshot)).toBe(
      true,
    );
    expect(getEphemeralChat(chatId)!.messages[0]!.displaySnapshot).toBeTruthy();

    expect(editEphemeralUserMessage(chatId, msg.id, "edited")).toBe(true);
    const edited = getEphemeralChat(chatId)!.messages[0]!;
    expect(edited.content).toBe("edited");
    expect(edited.displaySnapshot).toBeUndefined(); // stale snapshot gone
    deleteEphemeralChat(chatId);
  });

  it("truncates the tail after the edited message", () => {
    const chatId = createEphemeralWorkspaceChat(1);
    addEphemeralMessage(chatId, { role: "user", content: "first" });
    addEphemeralMessage(chatId, { role: "assistant", content: "reply" });
    addEphemeralMessage(chatId, { role: "user", content: "second" });
    const first = getEphemeralChat(chatId)!.messages[0]!;
    expect(editEphemeralUserMessage(chatId, first.id, "rewritten")).toBe(true);
    const msgs = getEphemeralChat(chatId)!.messages;
    expect(msgs.length).toBe(1);
    expect(msgs[0]!.content).toBe("rewritten");
    deleteEphemeralChat(chatId);
  });
});
