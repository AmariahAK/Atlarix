/**
 * v10.1: send → stream → tool card. A live stream-thread tool item renders a
 * StreamToolCallCard inside the assistant message body, updates on completion,
 * and frozen thread items render after the stream ends.
 */

import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, screen } from "@testing-library/react";
import {
  activeChatIdAtom,
  completedStreamThreadByAssistantMessageIdAtom,
  streamThreadByChatIdAtom,
} from "@/atoms/chatAtoms";
import type { StreamThreadItem } from "@/lib/chat/stream-thread";
import { makeFakeIpc, renderWithProviders } from "./helpers";

const fakeIpc = makeFakeIpc();

vi.mock("@/ipc/ipc_client", () => ({
  IpcClient: { getInstance: () => fakeIpc },
}));

import { AssistantMessageBody } from "@/components/chat/AssistantMessageBody";

const CHAT_ID = 7;
const MESSAGE_ID = 1001;

function toolItem(overrides: Partial<Extract<StreamThreadItem, { kind: "tool" }>> = {}) {
  return {
    kind: "tool" as const,
    id: "tool-1",
    toolName: "read_file",
    summary: "Read src/main.ts",
    detail: "",
    status: "running" as const,
    ts: 1,
    ...overrides,
  };
}

describe("stream → tool card", () => {
  beforeEach(() => {
    const { store } = renderWithProviders(<div />);
    store.set(streamThreadByChatIdAtom, new Map());
    store.set(completedStreamThreadByAssistantMessageIdAtom, {});
    store.set(activeChatIdAtom, CHAT_ID);
  });

  it("renders a running tool card from the live stream thread", () => {
    const { store } = renderWithProviders(
      <AssistantMessageBody
        content=""
        isStreaming
        chatId={CHAT_ID}
        assistantMessageId={MESSAGE_ID}
      />,
    );
    act(() => {
      store.set(
        streamThreadByChatIdAtom,
        new Map([[CHAT_ID, [toolItem()]]]),
      );
    });
    expect(screen.getByText("Read src/main.ts")).toBeInTheDocument();
  });

  it("flips the card to done with the result summary", () => {
    const { store } = renderWithProviders(
      <AssistantMessageBody
        content=""
        isStreaming
        chatId={CHAT_ID}
        assistantMessageId={MESSAGE_ID}
      />,
    );
    act(() => {
      store.set(
        streamThreadByChatIdAtom,
        new Map([
          [CHAT_ID, [toolItem({ status: "done", summary: "Read files (1)", endTs: 5 })]],
        ]),
      );
    });
    expect(screen.getByText("Read files (1)")).toBeInTheDocument();
  });

  it("renders frozen tool cards from the completed thread after the stream ends", () => {
    const { store } = renderWithProviders(
      <AssistantMessageBody
        content="All done."
        isStreaming={false}
        chatId={CHAT_ID}
        assistantMessageId={MESSAGE_ID}
      />,
    );
    act(() => {
      store.set(completedStreamThreadByAssistantMessageIdAtom, {
        [MESSAGE_ID]: [toolItem({ status: "done", summary: "Searched the web (3 results)" })],
      });
    });
    expect(screen.getByText("Searched the web (3 results)")).toBeInTheDocument();
    expect(screen.getByText("All done.")).toBeInTheDocument();
  });
});
