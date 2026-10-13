/**
 * QA (app) #16: the desktop had no slash commands — "/compact" went to the
 * model as text, which sometimes said "Nothing further to do" and compacted
 * nothing. Typed alone, it now compacts, as in the CLI.
 */
import React from "react";
import { describe, it, expect, vi } from "vitest";
import { act, fireEvent, screen } from "@testing-library/react";
import { makeFakeIpc, renderWithProviders } from "./helpers";

const compactChat = vi.fn(async () => ({ ok: true, message: "Compacted · ~40k → ~6k tokens." }));
const fakeIpc = Object.assign(makeFakeIpc(), { compactChat });
vi.mock("@/ipc/ipc_client", () => ({ IpcClient: { getInstance: () => fakeIpc } }));
vi.mock("@/hooks/useStreamChat", () => ({ useStreamChat: () => ({ streamMessage: vi.fn() }) }));
vi.mock("@/components/SimpleChatInput", () => ({
  SimpleChatInput: ({ onSubmit }: { onSubmit: (p: string, a?: unknown[]) => void }) => (
    <>
      <button onClick={() => onSubmit("/compact")}>send-compact</button>
      <button onClick={() => onSubmit("/compact the tests please")}>send-text</button>
    </>
  ),
}));
vi.mock("@/components/VirtualizedMessageList", () => ({ VirtualizedMessageList: () => null }));
vi.mock("@/lib/toast", () => ({ showInfo: vi.fn(), showError: vi.fn(), showSuccess: vi.fn() }));

import { SimpleInlineChat } from "@/components/SimpleInlineChat";

describe("/compact in the app", () => {
  it("compacts instead of sending a message", async () => {
    const onSendMessage = vi.fn();
    renderWithProviders(<SimpleInlineChat chatId={-5} onSendMessage={onSendMessage} />);
    await act(async () => fireEvent.click(screen.getByText("send-compact")));
    expect(compactChat).toHaveBeenCalledWith(expect.objectContaining({ chatId: -5 }));
    expect(onSendMessage).not.toHaveBeenCalled();
  });

  it("a message that merely starts with it is sent as usual", async () => {
    compactChat.mockClear();
    const onSendMessage = vi.fn();
    renderWithProviders(<SimpleInlineChat chatId={-6} onSendMessage={onSendMessage} />);
    await act(async () => fireEvent.click(screen.getByText("send-text")));
    expect(onSendMessage).toHaveBeenCalled();
    expect(compactChat).not.toHaveBeenCalled();
  });
});
