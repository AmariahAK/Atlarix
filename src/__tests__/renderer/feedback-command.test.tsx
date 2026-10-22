/**
 * `/feedback` in the app's composer goes to Atlarix, never to the model, like
 * the CLI's and every editor's (owner, 2026-10-22).
 */
import React from "react";
import { describe, it, expect, vi } from "vitest";
import { act, fireEvent, screen } from "@testing-library/react";
import { makeFakeIpc, renderWithProviders } from "./helpers";

const fakeIpc = makeFakeIpc();
const { openFeedbackFor } = vi.hoisted(() => ({ openFeedbackFor: vi.fn() }));
vi.mock("@/ipc/ipc_client", () => ({ IpcClient: { getInstance: () => fakeIpc } }));
vi.mock("@/hooks/useStreamChat", () => ({ useStreamChat: () => ({ streamMessage: vi.fn() }) }));
vi.mock("@/components/chat/SessionRatingCard", () => ({ openFeedbackFor, SessionRatingCard: () => null }));
vi.mock("@/components/SimpleChatInput", () => ({
  SimpleChatInput: ({ onSubmit }: { onSubmit: (p: string, a?: unknown[]) => void }) => (
    <>
      <button onClick={() => onSubmit("/feedback 3 great at refactors")}>send-feedback</button>
      <button onClick={() => onSubmit("/feedback")}>open-feedback</button>
    </>
  ),
}));
vi.mock("@/components/VirtualizedMessageList", () => ({ VirtualizedMessageList: () => null }));
vi.mock("@/lib/toast", () => ({ showInfo: vi.fn(), showError: vi.fn(), showSuccess: vi.fn() }));

import { SimpleInlineChat } from "@/components/SimpleInlineChat";

describe("/feedback in the app", () => {
  it("rates and sends the text, and the model never sees it", async () => {
    const onSendMessage = vi.fn();
    renderWithProviders(<SimpleInlineChat chatId={-7} onSendMessage={onSendMessage} />);
    await act(async () => fireEvent.click(screen.getByText("send-feedback")));
    expect(openFeedbackFor).toHaveBeenCalledWith(-7, { rating: 3, body: "great at refactors" });
    await act(async () => fireEvent.click(screen.getByText("open-feedback")));
    expect(openFeedbackFor).toHaveBeenLastCalledWith(-7, {});
    expect(onSendMessage).not.toHaveBeenCalled();
  });
});
