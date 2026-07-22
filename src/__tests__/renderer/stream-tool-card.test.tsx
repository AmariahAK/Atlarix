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

  it("keeps a completed tool card visible mid-stream in the interleaved branch (v12.10: accepted edit must not vanish on completion)", () => {
    // Structured content (has <think>) forces the interleaved timeline branch,
    // where running tools render via ipcTimelineTailItems. A permission-
    // interceptor write/edit never gets a content-tag part, so when it flips to
    // "done" it must STILL render — previously only "running" tools passed.
    const { store } = renderWithProviders(
      <AssistantMessageBody
        content="<think>Setting up the project.</think>"
        isStreaming
        chatId={CHAT_ID}
        assistantMessageId={MESSAGE_ID}
      />,
    );
    act(() => {
      store.set(
        streamThreadByChatIdAtom,
        new Map([
          [
            CHAT_ID,
            [
              toolItem({
                toolName: "write_file",
                status: "done",
                summary: "Wrote requirements.txt",
                endTs: 5,
              }),
            ],
          ],
        ]),
      );
    });
    expect(screen.getByText("Wrote requirements.txt")).toBeInTheDocument();
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

  // A native-FC delegation has no content tag, so its tool card always looked
  // "not represented in the parts" and landed in the tail — as a second
  // "Sub-agent finished" row beneath a panel already listing that agent.
  describe("delegate rows vs the sub-agent round panel", () => {
    const delegateRow = toolItem({
      id: "task-1",
      toolName: "task",
      status: "done" as const,
      summary: "Sub-agent finished",
      endTs: 5,
    });

    const roundItem = {
      kind: "subagent_round" as const,
      id: "round-1",
      status: "done" as const,
      ts: 2,
      agents: [
        {
          id: "agent-1",
          agentType: "scout",
          label: "Scout · traced the save flow",
          status: "done" as const,
          summary: "Traced it.",
          nestedItems: [],
        },
      ],
    };

    // Structured content (<think>) forces the interleaved branch — the one a
    // real delegation turn always takes, since delegating emits tool tags.
    it("drops the duplicate delegate row when a round panel represents it", () => {
      const { store } = renderWithProviders(
        <AssistantMessageBody
          content="<think>Delegating the trace.</think>All done."
          isStreaming={false}
          chatId={CHAT_ID}
          assistantMessageId={MESSAGE_ID}
        />,
      );
      act(() => {
        store.set(completedStreamThreadByAssistantMessageIdAtom, {
          [MESSAGE_ID]: [roundItem, delegateRow],
        });
      });
      // The panel is the single home for agents…
      expect(screen.getByText(/Scout · traced the save flow/)).toBeInTheDocument();
      // …and the delegate tool card must not repeat it at the tail.
      expect(screen.queryByText("Sub-agent finished")).not.toBeInTheDocument();
    });

    it("still renders a delegate row when NO panel represents it", () => {
      const { store } = renderWithProviders(
        <AssistantMessageBody
          content="<think>Delegating the trace.</think>All done."
          isStreaming={false}
          chatId={CHAT_ID}
          assistantMessageId={MESSAGE_ID}
        />,
      );
      act(() => {
        store.set(completedStreamThreadByAssistantMessageIdAtom, {
          [MESSAGE_ID]: [delegateRow],
        });
      });
      // Without a panel the delegate card is the only record of the run —
      // suppressing it here would lose the delegation entirely.
      expect(screen.getByText("Sub-agent finished")).toBeInTheDocument();
    });
  });
});
