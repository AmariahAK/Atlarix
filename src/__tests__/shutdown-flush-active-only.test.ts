/**
 * Quitting saves the reply of a turn that is still streaming, and nothing
 * else. A finished turn leaves its reply in `partialResponses`, and a stopped
 * one can too (a late chunk after the stop); the quit flush wrote each as an
 * interrupted row without the stop note, so a resumed chat re-ran the stopped
 * request (QA 15.7.1 #11, "shutdown flush for 4 active stream(s)" with one
 * running).
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("electron-log", () => ({
  default: { scope: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn(), log: vi.fn(), debug: vi.fn() }) },
}));
const { upsert } = vi.hoisted(() => ({
  upsert: vi.fn(async (..._args: unknown[]) => "row-1"),
}));
vi.mock("@/ipc/handlers/workspace_session_handlers", () => ({
  upsertInterruptedAssistantDraft: upsert,
}));

const state = await import("@/ipc/handlers/chat_stream/stream-state");
const { flushPartialStreamsForShutdown } = await import(
  "@/ipc/handlers/chat_stream/stream-lifecycle"
);

describe("the quit flush", () => {
  it("saves only the turns still streaming", async () => {
    state.partialResponses.set(1, "finished reply");
    state.streamSessionByChatId.set(1, "s1");
    state.partialResponses.set(2, "<think>The");
    state.streamSessionByChatId.set(2, "s2");
    state.partialResponses.set(3, "half a poem");
    state.streamSessionByChatId.set(3, "s3");
    state.activeStreams.set(3, new AbortController());

    await flushPartialStreamsForShutdown();

    expect(upsert).toHaveBeenCalledTimes(1);
    expect(upsert.mock.calls[0]![1]).toBe("s3");
  });
});

describe("a chunk that lands after the stop", () => {
  it("writes no second row and leaves nothing for the quit flush", async () => {
    upsert.mockClear();
    const { processResponseChunkUpdate } = await import(
      "@/ipc/handlers/chat_stream/turn-runner/response-chunk-update"
    );
    // Stream 7 on chat 9 was stopped: chat:cancel took it out of activeStreams.
    state.activeStreamId.set(9, 7);
    state.partialResponses.delete(9);
    await processResponseChunkUpdate(
      {
        req: { chatId: 9, workspaceSessionId: "s9" } as never,
        updatedChat: { messages: [] },
        event: { sender: { isDestroyed: () => true } } as never,
        streamId: 7,
      },
      { fullResponse: "<think>The" },
    );
    await new Promise((r) => setTimeout(r, 0));
    expect(state.partialResponses.has(9)).toBe(false);
    expect(upsert).not.toHaveBeenCalled();
  });
});
