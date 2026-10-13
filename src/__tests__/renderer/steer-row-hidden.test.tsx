/**
 * QA (app) #4: the steer's own row (stored in front of the reply) is not drawn
 * again above the answer once the reply's thread holds it.
 */
import React from "react";
import { describe, it, expect, vi } from "vitest";
import { act, screen } from "@testing-library/react";
import { chatMessagesByIdAtom, completedStreamThreadByAssistantMessageIdAtom } from "@/atoms/chatAtoms";
import { makeFakeIpc, renderWithProviders } from "./helpers";

const fakeIpc = makeFakeIpc();
vi.mock("@/ipc/ipc_client", () => ({ IpcClient: { getInstance: () => fakeIpc } }));
vi.mock("@/hooks/useStreamChat", () => ({ useStreamChat: () => ({ streamMessage: vi.fn() }) }));
vi.mock("@/components/SimpleChatInput", () => ({ SimpleChatInput: () => null }));
vi.mock("@/components/SimpleMessage", () => ({
  SimpleMessage: ({ message }: { message: { content: string } }) => <div data-testid="message">{message.content}</div>,
}));
vi.mock("@/components/chat/InlineUserQuestions", () => ({ InlineUserQuestions: () => null }));
vi.mock("@/components/chat/InlineStreamStatus", () => ({ InlineStreamStatus: () => null }));
vi.mock("@/components/chat/LoadedSessionBanner", () => ({ LoadedSessionBanner: () => null }));
vi.mock("@/lib/open-workspace-session", () => ({ startNewWorkspaceConversation: vi.fn() }));
vi.mock("@/components/VirtualizedMessageList", () => ({ VirtualizedMessageList: () => null }));

import { SimpleInlineChat } from "@/components/SimpleInlineChat";

describe("a steer's own row", () => {
  it("is not drawn above the answer once the reply holds it", () => {
    const { store } = renderWithProviders(
      <SimpleInlineChat chatId={-9} onSendMessage={() => {}} virtualizeHistory={false} />,
    );
    act(() => {
      store.set(
        chatMessagesByIdAtom,
        new Map([
          [
            -9,
            [
              { id: 1, role: "user", content: "Add a third test", sessionRowId: "r0" },
              { id: 2, role: "user", content: "Also add a test for n=1.", sessionRowId: "r1" },
              { id: 3, role: "assistant", content: "Done." },
            ] as never,
          ],
        ]),
      );
      store.set(completedStreamThreadByAssistantMessageIdAtom, {
        3: [{ kind: "interjection", id: "interj-r1", text: "Also add a test for n=1.", rowKey: "r1", ts: 1 }],
      } as never);
    });
    const shown = screen.getAllByTestId("message").map((e) => e.textContent);
    expect(shown).toEqual(["Add a third test", "Done."]);
  });
});
