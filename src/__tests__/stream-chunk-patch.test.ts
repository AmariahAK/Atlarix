/**
 * Streaming sends the full message list once per stream, then only the live
 * row's text (`patch`), coalesced to one per 50 ms — the fix for memory climbing
 * during a long Build turn, when every token re-sent the whole list.
 *
 * What must hold:
 *  - the first chunk of a stream carries `messages`; later ones carry `patch`
 *  - patches inside one window collapse to the LATEST text
 *  - anything else about the chat (a full list, the end) flushes the held patch
 *    first, so a stale "content so far" never lands after it
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  createStreamTransport,
  getStreamTransport,
  nextEphemeralMessageId,
} from "@/lib/chat/stream-transport";
import { processResponseChunkUpdate } from "@/ipc/handlers/chat_stream/turn-runner/response-chunk-update";
import { safeSend } from "@/ipc/utils/safe_sender";
import { liveTextPatch } from "@/ipc/handlers/chat_stream/turn-runner/response-chunk-update";
import { applyLiveTextPatch } from "@/lib/chat/live-text-patch";

interface Sent {
  channel: string;
  data: Record<string, unknown>;
}

let sent: Sent[];
let sender: {
  id: number;
  isDestroyed: () => boolean;
  send: (c: string, d: unknown) => void;
};
let chatId: number;
let placeholderId: number;

function chunk(fullResponse: string, streamId = 1) {
  const chat = getStreamTransport(chatId)!;
  return processResponseChunkUpdate(
    {
      req: { chatId } as never,
      updatedChat: chat,
      event: { sender } as never,
      streamId,
      placeholderAssistantMessage: { id: placeholderId },
    },
    { fullResponse },
  );
}

const chunks = () => sent.filter((s) => s.channel === "chat:response:chunk");

beforeEach(() => {
  vi.useFakeTimers();
  sent = [];
  sender = {
    id: 7,
    isDestroyed: () => false,
    send: (channel, data) =>
      sent.push({ channel, data: data as Record<string, unknown> }),
  };
  chatId = createStreamTransport(1);
  placeholderId = nextEphemeralMessageId();
  getStreamTransport(chatId)!.messages = [
    {
      id: nextEphemeralMessageId(),
      chatId,
      role: "user",
      content: "go",
      createdAt: new Date(),
    },
    {
      id: placeholderId,
      chatId,
      role: "assistant",
      content: "",
      createdAt: new Date(),
    },
  ] as never;
});

afterEach(() => {
  vi.useRealTimers();
});

describe("streaming chunks", () => {
  it("sends the full list first, then patches with only the live text", async () => {
    await chunk("a");
    vi.advanceTimersByTime(60);
    await chunk("ab");

    const [first, second] = chunks();
    expect(first!.data.messages).toBeDefined();
    expect(first!.data.patch).toBeUndefined();
    expect(second!.data.messages).toBeUndefined();
    // Only what changed since the full list: "b" from offset 1.
    expect(second!.data.patch).toEqual({
      messageId: placeholderId,
      start: 1,
      text: "b",
      length: 2,
    });
  });

  it("collapses patches inside one window to the latest text", async () => {
    await chunk("a");
    vi.advanceTimersByTime(60);
    await chunk("ab"); // leading edge: sent now
    await chunk("abc"); // held
    await chunk("abcd"); // replaces the held one
    expect(chunks()).toHaveLength(2);

    vi.advanceTimersByTime(60);
    expect(chunks()).toHaveLength(3);
    // Relative to what the receiver last got ("ab"), not to the dropped "abc".
    expect(chunks()[2]!.data.patch).toEqual({
      messageId: placeholderId,
      start: 2,
      text: "cd",
      length: 4,
    });
  });

  it("flushes the held patch before the end of the turn", async () => {
    await chunk("a");
    vi.advanceTimersByTime(60);
    await chunk("ab");
    await chunk("abc"); // held

    safeSend(sender as never, "chat:response:end", { chatId, streamId: 1 });

    const order = sent.filter((s) => s.channel !== "chat:token-usage");
    expect(order.map((s) => s.channel)).toEqual([
      "chat:response:chunk",
      "chat:response:chunk",
      "chat:response:chunk", // the held "abc", flushed before…
      "chat:response:end", // …the end
    ]);
    expect(order[2]!.data.patch).toEqual({
      messageId: placeholderId,
      start: 2,
      text: "c",
      length: 3,
    });

    // Nothing late after the end.
    const before = sent.length;
    vi.advanceTimersByTime(200);
    expect(sent).toHaveLength(before);
  });

  it("sends the full list again for a new stream on the same chat", async () => {
    await chunk("a", 1);
    vi.advanceTimersByTime(60);
    await chunk("b", 2);
    expect(chunks()[1]!.data.messages).toBeDefined();
  });
});

describe("live text patches", () => {
  it("round-trips appends and rewrites", () => {
    const cases: Array<[string, string]> = [
      ["", "hello"],
      ["hello", "hello world"],
      ["<think>a</think>dup dup", "<think>a</think>dup"], // dedupe shortened it
      ["abc", "abX tail"], // an earlier character changed
      ["same", "same"],
    ];
    for (const [prev, next] of cases) {
      expect(applyLiveTextPatch(prev, liveTextPatch(prev, next))).toBe(next);
    }
  });

  it("refuses a patch that does not fit what the receiver holds", () => {
    expect(
      applyLiveTextPatch("ab", { start: 5, text: "x", length: 6 }),
    ).toBeNull();
    expect(
      applyLiveTextPatch("ab", { start: 1, text: "x", length: 9 }),
    ).toBeNull();
    expect(applyLiveTextPatch("ab", undefined)).toBeNull();
  });
});
