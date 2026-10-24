/**
 * "Atlarix finished responding" was decided in the renderer by
 * `!document.hasFocus()`, which stayed true with another app in front (15.11.1
 * QA), so it never came. Every turn's end goes to main, which decides by the
 * same rule as the approval notification (no window focused).
 */
import React from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { getDefaultStore } from "jotai";
import { makeFakeIpc } from "./helpers";
import { selectedChatIdAtom } from "@/atoms/chatAtoms";

const fakeIpc = makeFakeIpc();
const notifyTurnDone = vi.fn();
(fakeIpc as unknown as { notifyTurnDone: typeof notifyTurnDone }).notifyTurnDone = notifyTurnDone;
vi.mock("@/ipc/ipc_client", () => ({
  IpcClient: { getInstance: () => fakeIpc },
}));

const { useStreamChat } = await import("@/hooks/useStreamChat");

const CHAT = -78;
let send: ((p: { prompt: string; chatId: number }) => Promise<void>) | null = null;

function Host() {
  const { streamMessage } = useStreamChat({ hasChatId: true });
  send = streamMessage as unknown as typeof send;
  return null;
}

afterEach(() => cleanup());

describe("a turn's end", () => {
  it("goes to main even while the page says it has focus", async () => {
    getDefaultStore().set(selectedChatIdAtom, CHAT);
    const hasFocus = vi.spyOn(document, "hasFocus").mockReturnValue(true);
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <Host />
      </QueryClientProvider>,
    );
    await act(async () => {
      await send?.({ prompt: "hi", chatId: CHAT });
    });
    const callbacks = fakeIpc.streamMessage.mock.calls.at(-1)?.[1] as { onEnd: (r: unknown) => void };
    expect(callbacks?.onEnd).toBeTypeOf("function");
    await act(async () => {
      callbacks.onEnd({ chatId: CHAT, updatedFiles: false, endedWaitingOnUser: false });
    });
    expect(notifyTurnDone).toHaveBeenCalledWith(false, CHAT);
    hasFocus.mockRestore();
  });
});
