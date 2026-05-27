import { describe, expect, it } from "vitest";
import {
  filterActivityForChat,
  removeActivityForChat,
  shouldUseStreamingSessionFastPath,
} from "@/lib/chat/activity-stream";
import type { ActivityStreamItem } from "@/atoms/sourceAtoms";

function item(
  id: string,
  chatId?: number,
): ActivityStreamItem {
  return {
    id,
    type: "tool",
    label: id,
    status: "done",
    timestamp: 1,
    chatId,
  };
}

describe("activity-stream helpers", () => {
  it("removeActivityForChat keeps other chats", () => {
    const items = [item("a", 1), item("b", 2), item("legacy")];
    expect(removeActivityForChat(items, 1)).toEqual([item("b", 2), item("legacy")]);
  });

  it("filterActivityForChat includes matching chat and legacy rows", () => {
    const items = [item("a", 1), item("b", 2), item("legacy")];
    expect(filterActivityForChat(items, 1).map((i) => i.id)).toEqual(["a", "legacy"]);
  });

  it("shouldUseStreamingSessionFastPath when chat is streaming", () => {
    const map = new Map<number, boolean>([[5, true], [7, false]]);
    expect(shouldUseStreamingSessionFastPath(5, map)).toBe(true);
    expect(shouldUseStreamingSessionFastPath(7, map)).toBe(false);
    expect(shouldUseStreamingSessionFastPath(undefined, map)).toBe(false);
  });
});
