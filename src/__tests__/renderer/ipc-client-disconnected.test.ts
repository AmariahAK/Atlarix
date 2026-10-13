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
      detail: "connect ECONNREFUSED 127.0.0.1:9",
      canResume: true,
    });
    expect(onError).toHaveBeenCalledWith(
      "Lost the connection to the provider (connect ECONNREFUSED 127.0.0.1:9). Try again.",
    );
  });
});
