import { describe, expect, it } from "vitest";
import {
  completeLastRunningStreamTool,
  completeStreamToolOnEnd,
  finalizeAllRunningStreamTools,
  finalizeRunningBackgroundItems,
  handleStreamToolEnd,
  hasSubagentRoundPanel,
  mergeNestedActivityIntoSubagentRound,
  mergeSubagentActivityIntoThread,
  proseAlreadyRendered,
  streamThreadItemFromActivity,
  synthesizeSubagentRoundFromParts,
  upsertStreamThreadItem,
} from "@/lib/chat/stream-thread";
import { filterDelegateToolParts } from "@/lib/chat/delegate-handoff";
import type { ActivityStreamItem } from "@/atoms/sourceAtoms";
import {
  flattenToolGroupsInThread,
  groupStreamThreadTools,
} from "@/lib/chat/group-stream-tools";
import { ensurePlanMarkersInAssistantContent } from "@/lib/plans/plan-artifacts";

describe("stream-thread", () => {
  it("upserts tool cards by id", () => {
    const running = {
      kind: "tool" as const,
      id: "read_file",
      toolName: "read_file",
      summary: "Reading files…",
      status: "running" as const,
      ts: 1,
    };
    const done = { ...running, status: "done" as const, summary: "Read files", ts: 2 };
    const items = upsertStreamThreadItem(
      upsertStreamThreadItem([], running),
      done,
    );
    expect(items).toHaveLength(1);
    expect(items[0]?.kind === "tool" && items[0].status).toBe("done");
  });

  it("does not downgrade done tool back to running on activity upsert", () => {
    const done = {
      kind: "tool" as const,
      id: "read_file",
      toolName: "read_file",
      summary: "Read files",
      status: "done" as const,
      ts: 1,
    };
    const runningAgain = { ...done, status: "running" as const, summary: "Reading files…", ts: 2 };
    const items = upsertStreamThreadItem([done], runningAgain);
    expect(items).toHaveLength(1);
    expect(items[0]?.kind === "tool" && items[0].status).toBe("done");
  });

  it("handleStreamToolEnd matches by toolId and sets past-tense summary", () => {
    const items = [
      {
        kind: "tool" as const,
        id: "read_file",
        toolName: "read_file",
        summary: "Reading files…",
        status: "running" as const,
        ts: 1,
      },
    ];
    const next = handleStreamToolEnd(items, {
      toolId: "read_file",
      detail: '{"result":"file contents here"}',
    });
    expect(next[0]?.kind === "tool" && next[0].status).toBe("done");
    expect(next[0]?.kind === "tool" && next[0].summary).toBe("Read files");
  });

  it("completeStreamToolOnEnd matches by toolId before last running", () => {
    const items = [
      {
        kind: "tool" as const,
        id: "read_file",
        toolName: "read_file",
        summary: "Read",
        status: "running" as const,
        ts: 1,
      },
      {
        kind: "tool" as const,
        id: "write_file",
        toolName: "write_file",
        summary: "Write",
        status: "running" as const,
        ts: 2,
      },
    ];
    const next = completeStreamToolOnEnd(items, { toolId: "read_file" });
    expect(next[0]?.kind === "tool" && next[0].status).toBe("done");
    expect(next[1]?.kind === "tool" && next[1].status).toBe("running");
  });

  it("finalizeAllRunningStreamTools marks every running tool done", () => {
    const items = [
      {
        kind: "tool" as const,
        id: "a",
        toolName: "a",
        summary: "A",
        status: "running" as const,
        ts: 1,
      },
      {
        kind: "tool" as const,
        id: "b",
        toolName: "b",
        summary: "B",
        status: "done" as const,
        ts: 2,
      },
    ];
    const next = finalizeAllRunningStreamTools(items);
    expect(next.every((i) => i.kind !== "tool" || i.status === "done")).toBe(true);
  });

  it("completeLastRunningStreamTool marks latest running tool done", () => {
    const items = [
      {
        kind: "tool" as const,
        id: "a",
        toolName: "read_file",
        summary: "Read",
        status: "done" as const,
        ts: 1,
      },
      {
        kind: "tool" as const,
        id: "b",
        toolName: "write_file",
        summary: "Write",
        status: "running" as const,
        ts: 2,
      },
    ];
    const next = completeLastRunningStreamTool(items);
    expect(next[1]?.kind === "tool" && next[1].status).toBe("done");
  });

  it("finalizeRunningBackgroundItems marks running background cards done", () => {
    const items = [
      {
        kind: "background" as const,
        id: "agent-1",
        label: "Agent working…",
        status: "running" as const,
        ts: 1,
      },
    ];
    const next = finalizeRunningBackgroundItems(items);
    expect(next[0]?.kind === "background" && next[0].status).toBe("done");
  });

  it("merges subagent activity into a subagent_round panel", () => {
    const start: ActivityStreamItem = {
      id: "sub-1",
      type: "subagent_start",
      label: "Sub-agent: Explore",
      status: "running",
      timestamp: 1,
      agent: "explore",
      agentType: "explore",
      scope: "packages/api",
      chatId: 1,
    };
    const done: ActivityStreamItem = {
      id: "sub-1",
      type: "subagent_complete",
      label: "Sub-agent: Explore",
      status: "done",
      timestamp: 2,
      agent: "explore",
      result: "Mapped API package",
      chatId: 1,
    };
    let items = mergeSubagentActivityIntoThread([], start);
    expect(items[0]?.kind).toBe("subagent_round");
    items = mergeSubagentActivityIntoThread(items, done);
    const round = items[0];
    expect(round?.kind).toBe("subagent_round");
    if (round?.kind === "subagent_round") {
      expect(round.agents[0]?.summary).toContain("Mapped");
    }
  });

  it("nests tool activity under subagent_round via parentDelegationId", () => {
    const start: ActivityStreamItem = {
      id: "delegation-1",
      type: "subagent_start",
      label: "Sub-agent: Explore",
      status: "running",
      timestamp: 1,
      agent: "explore",
      agentType: "explore",
      roundId: "turn-1",
      chatId: 1,
    };
    let items = mergeSubagentActivityIntoThread([], start);
    const nestedTool = {
      kind: "tool" as const,
      id: "read_file",
      toolName: "read_file",
      summary: "Reading files…",
      status: "done" as const,
      ts: 2,
    };
    items = mergeNestedActivityIntoSubagentRound(
      items,
      "delegation-1",
      nestedTool,
    );
    const round = items[0];
    expect(round?.kind).toBe("subagent_round");
    if (round?.kind === "subagent_round") {
      expect(round.agents[0]?.nestedItems).toHaveLength(1);
      expect(round.agents[0]?.nestedItems[0]?.kind).toBe("tool");
    }
  });

  it("flattenToolGroupsInThread expands nested tool_group inside subagent_round", () => {
    const round = {
      kind: "subagent_round" as const,
      id: "turn-1",
      status: "running" as const,
      ts: 1,
      agents: [
        {
          id: "delegation-1",
          agentType: "explore",
          label: "explore",
          status: "running" as const,
          nestedItems: [
            {
              kind: "tool_group" as const,
              id: "tg-read",
              category: "Read / explore",
              tools: [
                {
                  kind: "tool" as const,
                  id: "read_file",
                  toolName: "read_file",
                  summary: "a.ts",
                  status: "done" as const,
                  ts: 1,
                },
                {
                  kind: "tool" as const,
                  id: "read_file-2",
                  toolName: "explore_folder",
                  summary: "src",
                  status: "done" as const,
                  ts: 2,
                },
              ],
              summary: "Read / explore · 2 tools",
              status: "done" as const,
              ts: 2,
            },
          ],
        },
      ],
    };
    const flat = flattenToolGroupsInThread([round]);
    expect(flat[0]?.kind).toBe("subagent_round");
    if (flat[0]?.kind === "subagent_round") {
      expect(flat[0].agents[0]?.nestedItems).toHaveLength(2);
      expect(flat[0].agents[0]?.nestedItems.every((i) => i.kind === "tool")).toBe(
        true,
      );
    }
  });

  it("synthesizeSubagentRoundFromParts builds round from delegate handoffs", () => {
    const round = synthesizeSubagentRoundFromParts([
      { type: "markdown", content: "answer" },
      {
        type: "tool",
        id: "t1",
        toolName: "spawn_sub_agent",
        status: "success",
        handoff: {
          agentRole: "explore",
          summary: "Mapped API",
          validationStatus: "success",
          scope: "packages/api",
        },
      },
    ]);
    expect(round?.kind).toBe("subagent_round");
    expect(round?.agents).toHaveLength(1);
    expect(round?.agents[0]?.summary).toContain("Mapped API");
  });

  it("hasSubagentRoundPanel detects round items", () => {
    expect(hasSubagentRoundPanel([])).toBe(false);
    expect(
      hasSubagentRoundPanel([
        {
          kind: "subagent_round",
          id: "r1",
          agents: [],
          status: "running",
          ts: 0,
        },
      ]),
    ).toBe(true);
  });

  it("filterDelegateToolParts removes spawn/delegate tool rows when suppressed", () => {
    const parts = filterDelegateToolParts(
      [
        { type: "markdown", content: "hi" },
        {
          type: "tool",
          id: "1",
          toolName: "spawn_sub_agent",
          status: "success",
        },
      ],
      true,
    );
    expect(parts).toHaveLength(1);
    expect(parts[0]?.type).toBe("markdown");
  });

  it("groups consecutive read tools into tool_group", () => {
    const items = groupStreamThreadTools([
      {
        kind: "tool",
        id: "read_file",
        toolName: "read_file",
        summary: "a.ts",
        status: "done",
        ts: 1,
      },
      {
        kind: "tool",
        id: "read_file-2",
        toolName: "explore_folder",
        summary: "src",
        status: "done",
        ts: 2,
      },
    ]);
    expect(items).toHaveLength(1);
    expect(items[0]?.kind).toBe("tool_group");
  });

  it("maps background activity to background thread card", () => {
    const item: ActivityStreamItem = {
      id: "bg-1",
      type: "background",
      label: "Summarizing tool outputs",
      status: "running",
      timestamp: 100,
      chatId: 1,
    };
    const thread = streamThreadItemFromActivity(item);
    expect(thread?.kind).toBe("background");
  });
});

describe("proseAlreadyRendered", () => {
  it("detects duplicate trailing prose in markdown parts", () => {
    const prose = "Final answer for the user.";
    expect(
      proseAlreadyRendered(prose, [
        { type: "tool", content: "x" },
        { type: "markdown", content: prose },
      ]),
    ).toBe(true);
    expect(
      proseAlreadyRendered(prose, [{ type: "tool", content: "x" }]),
    ).toBe(false);
  });
});

describe("ensurePlanMarkersInAssistantContent", () => {
  it("appends marker when planId appears in tool JSON", () => {
    const id = "787bb61d-51c9-4476-9370-ee0d7a6a7832";
    const out = ensurePlanMarkersInAssistantContent(
      `{"success":true,"planId":"${id}"}`,
    );
    expect(out).toContain(`<!-- atlarix-plan-artifact:${id} -->`);
  });
});
