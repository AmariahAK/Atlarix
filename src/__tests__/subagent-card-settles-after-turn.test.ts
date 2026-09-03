/**
 * A sub-agent that finishes AFTER its turn ended must still settle its card.
 *
 * OBSERVED 2026-09-03 (packaged v14.41.0): the card sat on
 * "Sub-agents · 4/5 running" while all five had in fact completed —
 * `Subagent run complete` ×5 in the log between 11:20:42 and 11:25:16. The
 * background-tasks pill was correct the whole time, which is the tell: the pill
 * DERIVES from main-process state, the card LISTENED for a transient event, and
 * the stream's `chat:activity` listener is unsubscribed in its cleanup
 * (`useStreamChat.ts`). So every completion after stream end landed nowhere.
 *
 * `onBackgroundSettled` (register-delegation-tools) emits those events post-turn
 * on purpose — "this closure outlives the tool call". The missing half was a
 * receiver.
 *
 * These tests cover the MERGE, which is the part that has to be right: the ids
 * must line up and a non-owning thread must be left alone. The persistent
 * listener that calls it is wired in useStreamChat.
 */

import { describe, expect, it } from "vitest";
import {
  mergeSubagentActivityIntoThread,
  type StreamThreadItem,
} from "@/lib/chat/stream-thread";
import { normalizeChatActivityPayload } from "@/lib/chat-activity-normalize";
import { buildSubagentStartPayload } from "@/lib/chat/subagent-activity";

const CHAT = -42;
// The real shape, from the incident: the delegation id is what both the start
// and the completion carry, and what the card is keyed on. The task store's
// `taskId` is a separate randomUUID and cannot be used to match here.
const DELEGATION_ID = "delegation-1788423419919-explorer-7dfd3eb3";

function normalized(payload: Record<string, unknown>) {
  const item = normalizeChatActivityPayload(payload);
  if (!item) throw new Error("payload did not survive normalize");
  return item;
}

function startedThread(): StreamThreadItem[] {
  return mergeSubagentActivityIntoThread(
    [],
    normalized(
      buildSubagentStartPayload({
        id: DELEGATION_ID,
        chatId: CHAT,
        agentId: "explorer",
        task: "LinkedIn devto Medium recon",
      }),
    ),
  );
}

function completion(over: Record<string, unknown> = {}) {
  return normalized({
    type: "subagent_complete",
    id: DELEGATION_ID,
    chatId: CHAT,
    agent: "explorer",
    agentType: "explorer",
    parentDelegationId: DELEGATION_ID,
    status: "done",
    result: "Found the LinkedIn UGC Posts endpoint and its scopes.",
    timestamp: Date.now(),
    ...over,
  });
}

/**
 * The agent rows, which live in a `subagent_round` container's `agents[]`.
 *
 * They are plain objects with no `kind` of their own — worth stating, because a
 * walker that looks for `kind === "subagent"` finds nothing and every assertion
 * passes vacuously against an empty list.
 */
function agentRows(thread: StreamThreadItem[]) {
  const out: Array<{ id: string; status?: string; summary?: string }> = [];
  for (const it of thread) {
    const round = it as unknown as {
      kind: string;
      agents?: Array<{ id?: string; status?: string; summary?: string }>;
    };
    if (round.kind !== "subagent_round" || !Array.isArray(round.agents)) continue;
    for (const a of round.agents) {
      out.push({ id: a.id ?? "", status: a.status, summary: a.summary });
    }
  }
  return out;
}

describe("a post-turn completion settles the frozen card", () => {
  it("starts as running", () => {
    const rows = agentRows(startedThread());
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("running");
  });

  it("flips that row to done, and carries the result", () => {
    const settled = mergeSubagentActivityIntoThread(startedThread(), completion());
    const rows = agentRows(settled);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("done");
    expect(rows[0]!.summary).toContain("LinkedIn UGC Posts");
  });

  it("does not ADD a row — the ids must match, or the card would grow", () => {
    // If start and completion ever key differently, the merge appends instead of
    // updating and the header count goes UP rather than settling.
    const settled = mergeSubagentActivityIntoThread(startedThread(), completion());
    expect(agentRows(settled)).toHaveLength(1);
  });

  it("records an error completion as error, not done", () => {
    const settled = mergeSubagentActivityIntoThread(
      startedThread(),
      completion({ status: "error", result: "provider timeout" }),
    );
    expect(agentRows(settled)[0]!.status).toBe("error");
  });

  it("leaves a thread that does not own the sub-agent REFERENTIALLY identical", () => {
    // The listener merges across every frozen message, so a non-owning thread
    // must come back unchanged — that is what lets it detect "nothing changed"
    // and skip the atom write.
    const other = mergeSubagentActivityIntoThread(
      [],
      normalized(
        buildSubagentStartPayload({
          id: "delegation-other-explorer-99999999",
          chatId: CHAT,
          agentId: "explorer",
          task: "something else",
        }),
      ),
    );
    const after = mergeSubagentActivityIntoThread(other, completion());
    // A different id must not settle this one.
    expect(agentRows(after).find((r) => r.id.includes("other"))?.status).toBe(
      "running",
    );
  });

  it("settles all five independently — the reported case", () => {
    const ids = [
      "delegation-1788423419919-explorer-7dfd3eb3",
      "delegation-1788423419919-explorer-8b0a9b6d",
      "delegation-1788423419920-explorer-6bf7873d",
      "delegation-1788423419920-explorer-bcb43917",
      "delegation-1788423419920-explorer-c4bb3c49",
    ];
    let thread: StreamThreadItem[] = [];
    for (const id of ids) {
      thread = mergeSubagentActivityIntoThread(
        thread,
        normalized(
          buildSubagentStartPayload({
            id,
            chatId: CHAT,
            agentId: "explorer",
            task: `recon ${id.slice(-4)}`,
          }),
        ),
      );
    }
    expect(agentRows(thread).filter((r) => r.status === "running")).toHaveLength(5);

    for (const id of ids) {
      thread = mergeSubagentActivityIntoThread(
        thread,
        normalized({
          type: "subagent_complete",
          id,
          chatId: CHAT,
          agent: "explorer",
          agentType: "explorer",
          parentDelegationId: id,
          status: "done",
          result: "done",
          timestamp: Date.now(),
        }),
      );
    }
    const rows = agentRows(thread);
    expect(rows).toHaveLength(5);
    expect(rows.filter((r) => r.status === "done")).toHaveLength(5);
    expect(rows.filter((r) => r.status === "running")).toHaveLength(0);
  });
});
