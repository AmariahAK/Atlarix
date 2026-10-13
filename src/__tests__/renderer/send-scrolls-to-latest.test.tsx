/**
 * QA (app) #9: sending a message while scrolled up left the view where it was:
 * the new turn ran off-screen with only "Jump to latest" showing. Sending is
 * "take me to the conversation's end", as in every chat app; a teammate's
 * message arriving is not, so it does not move you.
 */
import React, { forwardRef, useImperativeHandle } from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, render } from "@testing-library/react";
import type { Message } from "@/ipc/ipc_types";

const scrollToIndex = vi.fn();
vi.mock("react-virtuoso", () => ({
  Virtuoso: forwardRef((_props: unknown, ref) => {
    useImperativeHandle(ref, () => ({ scrollToIndex }));
    return <div />;
  }),
}));
vi.mock("@/components/SimpleMessage", () => ({ SimpleMessage: () => null }));

import { VirtualizedMessageList } from "@/components/VirtualizedMessageList";

const m = (id: number, role: string, content = `m${id}`) => ({ id, role, content }) as unknown as Message;
const peer = '<atlarix-peer-message from="Docs" reply-to="s9" surface="cli" workspace="/w">\nFYI\n</atlarix-peer-message>';

function list(messages: Message[]) {
  return (
    <VirtualizedMessageList
      messages={messages}
      chatId={7}
      workspaceAppId={null}
      isStreaming={false}
      lastAssistantIndex={1}
      onEditUserMessage={async () => {}}
      onContinue={() => {}}
    />
  );
}

beforeEach(() => scrollToIndex.mockClear());

describe("sending while scrolled up", () => {
  it("takes you to the new message", async () => {
    const { rerender } = render(list([m(1, "user"), m(2, "assistant")]));
    scrollToIndex.mockClear();
    rerender(list([m(1, "user"), m(2, "assistant"), m(3, "user", "next question")]));
    await act(async () => new Promise((r) => requestAnimationFrame(() => r())));
    expect(scrollToIndex).toHaveBeenCalledWith(expect.objectContaining({ index: "LAST" }));
  });

  it("a teammate's message does not move you", async () => {
    const { rerender } = render(list([m(1, "user"), m(2, "assistant")]));
    scrollToIndex.mockClear();
    rerender(list([m(1, "user"), m(2, "assistant"), m(3, "user", peer)]));
    await act(async () => new Promise((r) => requestAnimationFrame(() => r())));
    expect(scrollToIndex).not.toHaveBeenCalled();
  });
});
