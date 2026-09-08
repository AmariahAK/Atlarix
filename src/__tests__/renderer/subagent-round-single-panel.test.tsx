/**
 * THE ROUND PANEL RENDERS ONCE. Mid-stream, on BOTH branches.
 *
 * `AssistantMessageBody`'s legacy branch mounted `SubAgentsRoundPanel` twice
 * while streaming: once from `liveThread.map` (the thread carries a
 * `subagent_round` item and `StreamThreadItemView` mounts a panel for it) and
 * once from the unconditional `inlineSubagentRound` render after the parts. Four
 * agents ran, `4/4 running` was correct, and the PANEL appeared twice — labelled
 * differently each time, because a single round short-circuits
 * `consolidateSubagentRoundsInThread` so the thread copy never reaches
 * `pickSubagentDisplayLabel` and keeps the raw IPC label.
 *
 * Why it survived: `assistant-message-trailing-parity` claimed to cover the panel
 * and did not — it carries no sub-agent assertion, and every case runs
 * `isStreaming={false}`, which is exactly the state where the double mount does
 * not appear. So the assertions here are deliberately mid-stream, and they count
 * panels rather than checking one is present.
 *
 * The legacy branch is the one that matters: a native-function-calling delegation
 * emits no `<think>` and no tool tags in the assistant text, so it takes legacy —
 * `AssistantMessageBody`'s own comment says so. The interleaved case is the
 * control that was always correct.
 */

import React from "react";
import { describe, it, expect, vi } from "vitest";
import { screen, act } from "@testing-library/react";
import { makeFakeIpc, renderWithProviders } from "./helpers";

const fakeIpc = makeFakeIpc();

vi.mock("@/ipc/ipc_client", () => ({
  IpcClient: { getInstance: () => fakeIpc },
}));

import { AssistantMessageBody } from "@/components/chat/AssistantMessageBody";
import { streamThreadByChatIdAtom } from "@/atoms/chatAtoms";

const CHAT_ID = 7;
const MESSAGE_ID = 9001;

/** Two agents still running — the state a live delegation turn is in. */
const runningRound = {
  kind: "subagent_round" as const,
  id: "round-1",
  status: "running" as const,
  ts: 2,
  agents: [
    {
      id: "delegation-1",
      agentType: "explorer",
      label: "Sub-agent: Explorer",
      status: "running" as const,
      nestedItems: [],
    },
    {
      id: "delegation-2",
      agentType: "architect",
      label: "Sub-agent: Architect",
      status: "running" as const,
      nestedItems: [],
    },
  ],
};

/**
 * `isStructured` keys off `<think>` / `<atlarix-tool-*>`, so plain prose takes the
 * legacy branch and a tool tag routes to interleaved.
 */
const BRANCHES = [
  { name: "legacy (plain prose — the delegation case)", content: "Working on it." },
  {
    name: "interleaved (isStructured)",
    content: "<think>Delegating.</think>Working on it.",
  },
];

describe("the sub-agent round panel renders exactly once mid-stream", () => {
  for (const branch of BRANCHES) {
    it(`${branch.name}`, () => {
      const { store } = renderWithProviders(
        <AssistantMessageBody
          content={branch.content}
          isStreaming
          chatId={CHAT_ID}
          assistantMessageId={MESSAGE_ID}
        />,
      );

      act(() => {
        store.set(streamThreadByChatIdAtom, new Map([[CHAT_ID, [runningRound]]]));
      });

      // The header is the panel's identity: one button per mounted panel.
      const panels = screen.getAllByRole("button", {
        name: /Sub-agents · 2\/2 running/,
      });
      expect(panels).toHaveLength(1);
    });
  }

  /**
   * The labelling difference was the visible symptom and the thing that named the
   * two sources, so pin it: the surviving panel is the one that went through
   * `pickSubagentDisplayLabel`. A live round is expanded, so the agent labels are
   * already in the DOM without a click.
   */
  it("keeps the resolved label, not the raw IPC one, and shows each agent once", () => {
    const { store } = renderWithProviders(
      <AssistantMessageBody
        content="Working on it."
        isStreaming
        chatId={CHAT_ID}
        assistantMessageId={MESSAGE_ID}
      />,
    );

    act(() => {
      store.set(streamThreadByChatIdAtom, new Map([[CHAT_ID, [runningRound]]]));
    });

    expect(screen.getAllByText(/Explorer/)).toHaveLength(1);
    expect(screen.getAllByText(/Architect/)).toHaveLength(1);
  });
});
