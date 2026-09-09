// @vitest-environment jsdom
/**
 * v14.8.10 Fix S: stream-scoped lifecycle events. A superseded (older) stream
 * leg's late chat:response:end / error must NOT invoke the live leg's callbacks
 * or tear down its chatStreams entry (observed live: three 429s → error+end for
 * the dying leg crossed a queued model-switch continue → inline chat froze
 * while the new turn ran).
 *
 * Rules under test (IpcClient.shouldDropStreamEvent):
 *  - while a chat:stream dispatch is PENDING for the chat, every
 *    chat:response:* event predates the new leg → dropped;
 *  - after the invoke resolves with { streamId }, events with a LOWER
 *    streamId are dropped; equal/higher pass (higher updates the watermark);
 *  - unstamped events (legacy paths) pass when no dispatch is pending.
 */
import { describe, expect, it, vi, beforeAll } from "vitest";

type Listener = (payload: unknown) => void;
const listeners = new Map<string, Listener>();

let resolveInvoke: ((v: unknown) => void) | null = null;
const invokeMock = vi.fn((channel: string) => {
  if (channel === "chat:stream") {
    return new Promise((resolve) => {
      resolveInvoke = resolve;
    });
  }
  return Promise.resolve(undefined);
});

beforeAll(() => {
  (window as unknown as { electron: unknown }).electron = {
    ipcRenderer: {
      on: (channel: string, cb: Listener) => {
        listeners.set(channel, cb);
      },
      removeAllListeners: () => {},
      removeListener: () => {},
      send: () => {},
      invoke: invokeMock,
    },
  };
});

function fire(channel: string, payload: unknown) {
  listeners.get(channel)?.(payload);
}

describe("IpcClient stream-leg scoping", () => {
  it("drops a superseded leg's late end/error and accepts the live leg's", async () => {
    const { IpcClient } = await import("@/ipc/ipc_client");
    const client = IpcClient.getInstance();

    const onUpdate = vi.fn();
    const onEnd = vi.fn();
    const onError = vi.fn();
    client.streamMessage("hello", {
      chatId: 42,
      redo: false,
      onUpdate,
      onEnd,
      onError,
    } as never);

    // Dispatch is pending — the dying leg's error+end (sent by main BEFORE the
    // new handler leg even ran) must be dropped entirely.
    fire("chat:response:error", {
      chatId: 42,
      streamId: 5,
      error: "rate limited",
    });
    fire("chat:response:end", { chatId: 42, streamId: 5 });
    expect(onError).not.toHaveBeenCalled();
    expect(onEnd).not.toHaveBeenCalled();

    // Invoke resolves: the new leg is streamId 6.
    resolveInvoke?.({ streamId: 6 });
    await Promise.resolve();
    await Promise.resolve();

    // Another stale leg-5 terminal arrives — still dropped by id comparison.
    fire("chat:response:end", { chatId: 42, streamId: 5 });
    expect(onEnd).not.toHaveBeenCalled();

    // Stale chunk dropped too; live chunk passes.
    fire("chat:response:chunk", { chatId: 42, streamId: 5, messages: [] });
    expect(onUpdate).not.toHaveBeenCalled();
    fire("chat:response:chunk", { chatId: 42, streamId: 6, messages: [] });
    expect(onUpdate).toHaveBeenCalledTimes(1);

    // The live leg's own end passes and tears down normally.
    fire("chat:response:end", { chatId: 42, streamId: 6 });
    expect(onEnd).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();
  });

  it("accepts unstamped events when no dispatch is pending (legacy paths)", async () => {
    const { IpcClient } = await import("@/ipc/ipc_client");
    const client = IpcClient.getInstance();

    const onEnd = vi.fn();
    client.streamMessage("hi", {
      chatId: 77,
      redo: false,
      onUpdate: vi.fn(),
      onEnd,
      onError: vi.fn(),
    } as never);
    resolveInvoke?.({ streamId: 9 });
    await Promise.resolve();
    await Promise.resolve();

    // Unstamped end (e.g. the chat:cancel path) is accepted.
    fire("chat:response:end", { chatId: 77 });
    expect(onEnd).toHaveBeenCalledTimes(1);
  });
});
