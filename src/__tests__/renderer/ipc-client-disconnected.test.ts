// @vitest-environment jsdom
/**
 * When the silent network retries run out, main sends ONLY
 * chat:stream:disconnected (no end, no error). The app had no listener, so the
 * turn stayed "streaming" for good. It now ends as an error with the reason.
 */
import { describe, expect, it, vi, beforeAll } from "vitest";

type Listener = (payload: unknown) => void;
const listeners = new Map<string, Listener>();

beforeAll(() => {
  (window as unknown as { electron: unknown }).electron = {
    ipcRenderer: {
      on: (channel: string, cb: Listener) => listeners.set(channel, cb),
      removeAllListeners: () => {},
      removeListener: () => {},
      send: () => {},
      invoke: vi.fn(async () => ({ streamId: 1 })),
    },
  };
});

describe("a stream whose network retries ran out", () => {
  it("ends the turn as an error that says what happened", async () => {
    const { IpcClient } = await import("@/ipc/ipc_client");
    const client = IpcClient.getInstance();
    const onError = vi.fn();
    client.streamMessage("hello", { chatId: 77, redo: false, onUpdate: vi.fn(), onEnd: vi.fn(), onError } as never);
    await new Promise((r) => setTimeout(r, 0));
    listeners.get("chat:stream:disconnected")?.({
      chatId: 77,
      reason: "network",
      providerName: "QA Dead Port",
      detail: "connect ECONNREFUSED 127.0.0.1:9",
      canResume: true,
    });
    // The CLI and editor's sentence (ec6bdc46).
    expect(onError).toHaveBeenCalledWith(
      "Couldn't reach QA Dead Port: connect ECONNREFUSED 127.0.0.1:9. Check it's running and the address is right, then try again.",
    );
  });
});

describe("a stream that dropped mid-reply", () => {
  it("says the connection was lost, not that the provider is unreachable", async () => {
    const { IpcClient } = await import("@/ipc/ipc_client");
    const onError = vi.fn();
    IpcClient.getInstance().streamMessage("hi", { chatId: 78, redo: false, onUpdate: vi.fn(), onEnd: vi.fn(), onError } as never);
    await new Promise((r) => setTimeout(r, 0));
    listeners.get("chat:stream:disconnected")?.({ chatId: 78, partialResponse: "Half an ans", detail: "socket hang up" });
    expect(onError).toHaveBeenCalledWith("Lost the connection to the model provider mid-reply: socket hang up. Try again.");
  });
});
