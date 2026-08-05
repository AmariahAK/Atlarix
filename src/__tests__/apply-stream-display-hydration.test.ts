/**
 * Session load must keep the MERGED thread, not a snapshot-only rebuild.
 *
 * `hydrateStreamDisplayForMessages` → `threadFromSnapshot` deliberately does two
 * things: it takes the persisted snapshot's thread AND merges in the sub-agent round
 * recovered from the assistant's raw content (`mergeSubAgentRunEntries`), because the
 * two sources can each hold agents the other doesn't.
 *
 * `applyStreamDisplayHydration` then used to recompute a thread from the snapshot
 * ALONE and assign it over the top — so on every session load that merge was computed
 * and immediately discarded, and any sub-agent entry that existed only in the content
 * disappeared. It also meant flatten+consolidate ran twice per assistant message.
 *
 * This pins the merge surviving. It was verified to FAIL (agents: 1, missing the
 * content-derived entry) with the overwrite restored.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { getDefaultStore } from "jotai";
import { completedStreamThreadByAssistantMessageIdAtom } from "@/atoms/chatAtoms";
import {
  applyStreamDisplayHydration,
  replaceDisplayHydrationForChat,
} from "@/lib/chat/apply-stream-display-hydration";
import type { DisplaySnapshotV1 } from "@/lib/chat/display-snapshot";
import type { Message } from "@/ipc/ipc_types";

const MSG_ID = 4242;

/** A snapshot round holding ONE agent. */
function snapshotWithOneAgent(): DisplaySnapshotV1 {
  return {
    version: 1,
    completedThread: [
      {
        kind: "subagent_round",
        id: "round-1",
        agents: [
          {
            id: "from-snapshot",
            agentType: "explore",
            label: "explore · /repo",
            scope: "/repo",
            status: "done",
            nestedItems: [],
          },
        ],
        status: "done",
        ts: 1,
      },
    ],
  };
}

/**
 * Assistant content whose `task` tool call synthesizes a SECOND agent entry
 * (synthesizeSubagentRoundFromParts, via isDelegateToolName("task")).
 */
const CONTENT_WITH_TASK = [
  "Here is what I found.",
  '<atlarix-tool-call tool="task" id="t9">{"task":"map the auth flow"}</atlarix-tool-call>',
  '<atlarix-tool-result tool="task" id="t9">Mapped six files under src/auth.</atlarix-tool-result>',
].join("\n");

function messageFixture(): Message {
  return {
    id: MSG_ID,
    chatId: 1,
    role: "assistant",
    content: CONTENT_WITH_TASK,
    createdAt: new Date(0),
    displaySnapshot: snapshotWithOneAgent(),
  } as unknown as Message;
}

function roundAgentsFor(id: number): string[] {
  const threads = getDefaultStore().get(completedStreamThreadByAssistantMessageIdAtom);
  const round = (threads[id] ?? []).find((i) => i.kind === "subagent_round");
  if (!round || round.kind !== "subagent_round") return [];
  return round.agents.map((a) => a.id);
}

beforeEach(() => {
  getDefaultStore().set(completedStreamThreadByAssistantMessageIdAtom, {});
});

describe("applyStreamDisplayHydration", () => {
  it("keeps sub-agent entries that exist only in the assistant content", () => {
    applyStreamDisplayHydration([messageFixture()]);
    const agents = roundAgentsFor(MSG_ID);
    expect(agents).toContain("from-snapshot");
    // The content-derived entry is what the overwrite used to destroy.
    expect(agents.length).toBeGreaterThan(1);
  });

  it("replaceDisplayHydrationForChat keeps the merge too", () => {
    replaceDisplayHydrationForChat(1, [messageFixture()]);
    expect(roundAgentsFor(MSG_ID).length).toBeGreaterThan(1);
  });

  it("replace clears a previous chat's entry before rehydrating", () => {
    // Session switching must not leave the old thread behind for a reused id.
    applyStreamDisplayHydration([messageFixture()]);
    const before = roundAgentsFor(MSG_ID).length;
    replaceDisplayHydrationForChat(1, [messageFixture()]);
    // Same content in, same shape out — no accumulation from the re-run.
    expect(roundAgentsFor(MSG_ID).length).toBe(before);
  });

  it("a snapshot with no content-derived round still hydrates from the snapshot", () => {
    const plain = {
      ...messageFixture(),
      content: "Just prose, no tool tags.",
    } as unknown as Message;
    applyStreamDisplayHydration([plain]);
    expect(roundAgentsFor(MSG_ID)).toEqual(["from-snapshot"]);
  });
});
