import { describe, expect, it } from "vitest";
import {
  compareThreadItems,
  completeLastRunningStreamTool,
  completeStreamToolOnEnd,
  finalizeAllRunningStreamTools,
  finalizeRunningBackgroundItems,
  handleStreamToolEnd,
  hasSubagentRoundPanel,
  mergeNestedActivityIntoSubagentRound,
  mergeNestedToolActivityIntoSubagentRound,
  mergeSubagentActivityIntoThread,
  mergeSubAgentRunEntries,
  pickSubagentDisplayLabel,
  resolveSubagentCardLabel,
  isDelegationIdLabel,
  proseAlreadyRendered,
  resolveLiveSubagentRound,
  splitInterleavedAroundDelegates,
  streamThreadItemFromActivity,
  streamThreadItemFromToolStart,
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

  it("keeps two calls of the SAME tool as distinct cards when keyed by callId (Fix 2)", () => {
    const a = streamThreadItemFromToolStart({
      toolId: "edit_file",
      toolCallId: "call_a",
      toolArgs: { path: "a.ts" },
    });
    const b = streamThreadItemFromToolStart({
      toolId: "edit_file",
      toolCallId: "call_b",
      toolArgs: { path: "b.ts" },
    });
    const items = upsertStreamThreadItem(upsertStreamThreadItem([], a), b);
    // Two distinct per-call ids ⇒ two cards (no merge-collision/"1 line").
    expect(items).toHaveLength(2);
    expect(items[0]?.kind === "tool" && items[0].id).toBe("call_a");
    expect(items[1]?.kind === "tool" && items[1].id).toBe("call_b");
    // Ending call_a finalizes ONLY that card, by id.
    const ended = handleStreamToolEnd(items, {
      toolCallId: "call_a",
      toolName: "edit_file",
      status: "done",
    });
    expect(ended[0]?.kind === "tool" && ended[0].status).toBe("done");
    expect(ended[1]?.kind === "tool" && ended[1].status).toBe("running");
  });

  it("pins ts on running→done merge so the card never reorders (Fix 2)", () => {
    const running = streamThreadItemFromToolStart({
      toolId: "read_file",
      toolCallId: "call_x",
      toolArgs: { path: "x.ts" },
    });
    const insertedTs = (running as { ts: number }).ts;
    const done = {
      ...(running as Record<string, unknown>),
      status: "done" as const,
      ts: insertedTs + 10_000, // completion time is later
    } as typeof running;
    const items = upsertStreamThreadItem([running], done);
    expect(items).toHaveLength(1);
    // ts must stay the ORIGINAL insertion time, not the completion time.
    expect(items[0]?.kind === "tool" && items[0].ts).toBe(insertedTs);
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

  it("handleStreamToolEnd builds an expandable card from resultText (not 'Done' detail)", () => {
    const items = [
      {
        kind: "tool" as const,
        id: "list_available_mcps",
        toolName: "list_available_mcps",
        summary: "Listing MCP servers…",
        status: "running" as const,
        ts: 1,
      },
    ];
    const resultText = JSON.stringify({
      success: true,
      result: {
        servers: [{ name: "github", tools: [{ name: "search_issues" }] }],
        usage: "Call mcp_call(...)",
      },
    });
    const next = handleStreamToolEnd(items, {
      toolId: "list_available_mcps",
      detail: "Done",
      resultText,
    });
    const tool = next[0];
    expect(tool?.kind === "tool" && tool.status).toBe("done");
    expect(tool?.kind === "tool" && tool.expand?.kind).toBe("mcp_servers");
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

  it("streamThreadItemFromActivity uses activity id for nested delegation tools", () => {
    const a: ActivityStreamItem = {
      id: "sub-tool-del-1-read_file-100",
      type: "tool_use",
      toolName: "read_file",
      label: "read_file",
      status: "running",
      parentDelegationId: "delegation-1",
      timestamp: 1,
      chatId: 1,
    };
    const b: ActivityStreamItem = {
      id: "sub-tool-del-1-read_file-200",
      type: "tool_use",
      toolName: "read_file",
      label: "read_file",
      status: "done",
      parentDelegationId: "delegation-1",
      timestamp: 2,
      chatId: 1,
    };
    const itemA = streamThreadItemFromActivity(a);
    const itemB = streamThreadItemFromActivity(b);
    expect(itemA?.kind).toBe("tool");
    expect(itemB?.kind).toBe("tool");
    if (itemA?.kind === "tool" && itemB?.kind === "tool") {
      expect(itemA.id).toBe("sub-tool-del-1-read_file-100");
      expect(itemB.id).toBe("sub-tool-del-1-read_file-200");
      expect(itemA.id).not.toBe(itemB.id);
    }
  });

  it("nests two read_file tools under same agent without merging", () => {
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
    const tool1 = streamThreadItemFromActivity({
      id: "sub-tool-del-1-read_file-100",
      type: "tool_use",
      toolName: "read_file",
      label: "read_file",
      status: "running",
      parentDelegationId: "delegation-1",
      timestamp: 2,
      chatId: 1,
    })!;
    const tool2 = streamThreadItemFromActivity({
      id: "sub-tool-del-1-read_file-200",
      type: "tool_use",
      toolName: "read_file",
      label: "read_file",
      status: "done",
      parentDelegationId: "delegation-1",
      timestamp: 3,
      chatId: 1,
    })!;
    items = mergeNestedActivityIntoSubagentRound(items, "delegation-1", tool1);
    items = mergeNestedActivityIntoSubagentRound(items, "delegation-1", tool2);
    const round = items[0];
    expect(round?.kind).toBe("subagent_round");
    if (round?.kind === "subagent_round") {
      expect(round.agents[0]?.nestedItems).toHaveLength(2);
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

  it("interleaves nested thoughts and tools by insertion order (same-ms ties)", () => {
    const base = {
      agent: "explore",
      agentType: "explore",
      roundId: "turn-1",
      chatId: 1,
      status: "running" as const,
    };
    let items = mergeSubagentActivityIntoThread([], {
      id: "d1",
      type: "subagent_start",
      label: "explore",
      timestamp: 1,
      ...base,
    } as ActivityStreamItem);
    // thought A, then a tool, then thought B — all in the SAME millisecond.
    items = mergeSubagentActivityIntoThread(items, {
      id: "d1",
      type: "subagent_progress",
      preview: "thought A",
      timestamp: 5,
      ...base,
    } as ActivityStreamItem);
    const tool = streamThreadItemFromActivity({
      id: "sub-tool-d1-grep-1",
      type: "tool_use",
      toolName: "grep",
      label: "grep",
      status: "done",
      parentDelegationId: "d1",
      timestamp: 5,
      chatId: 1,
    })!;
    items = mergeNestedActivityIntoSubagentRound(items, "d1", tool);
    items = mergeSubagentActivityIntoThread(items, {
      id: "d1",
      type: "subagent_progress",
      preview: "thought B",
      timestamp: 5,
      ...base,
    } as ActivityStreamItem);

    const round = items[0];
    expect(round?.kind).toBe("subagent_round");
    if (round?.kind !== "subagent_round") return;
    const nested = [...round.agents[0]!.nestedItems].sort(compareThreadItems);
    // Every nested item is seq-stamped, so same-ms ties are deterministic
    // (not grouped): the tool stays BETWEEN the two thoughts.
    expect(nested.every((i) => typeof i.seq === "number")).toBe(true);
    expect(
      nested.map((i) => (i.kind === "thought" ? i.content : i.kind)),
    ).toEqual(["thought A", "tool", "thought B"]);
  });

  it("buildCompletedStreamThreadFromAssistantContent rebuilds tools and subagent round", async () => {
    const { buildCompletedStreamThreadFromAssistantContent } = await import(
      "@/lib/chat/stream-thread"
    );
    const content = [
      "<think>Planning scan</think>",
      '<atlarix-tool-call tool="explore_folder" id="t1"></atlarix-tool-call>',
      '<atlarix-tool-result tool="explore_folder" id="t1">Found 12 files in src/</atlarix-tool-result>',
      "## Workspace Overview",
      "Multi-repo platform.",
    ].join("\n");
    const thread = buildCompletedStreamThreadFromAssistantContent(content);
    expect(thread.some((i) => i.kind === "thought")).toBe(true);
    expect(thread.some((i) => i.kind === "tool")).toBe(true);
  });

  it("subagent_progress updates summary and appends nested progress history", () => {
    const start: ActivityStreamItem = {
      id: "delegation-1",
      type: "subagent_start",
      label: "explore · api",
      status: "running",
      timestamp: 1,
      agent: "explore",
      agentType: "explore",
      roundId: "turn-1",
      chatId: 1,
    };
    let items = mergeSubagentActivityIntoThread([], start);
    items = mergeSubagentActivityIntoThread(items, {
      id: "delegation-1",
      type: "subagent_progress",
      preview: "Reading package.json",
      label: "explore",
      status: "running",
      timestamp: 2,
      agent: "explore",
      agentType: "explore",
      roundId: "turn-1",
      chatId: 1,
    });
    items = mergeSubagentActivityIntoThread(items, {
      id: "delegation-1",
      type: "subagent_progress",
      preview: "Listed files",
      label: "explore",
      status: "running",
      timestamp: 3,
      agent: "explore",
      agentType: "explore",
      roundId: "turn-1",
      chatId: 1,
    });
    const round = items[0];
    expect(round?.kind).toBe("subagent_round");
    if (round?.kind === "subagent_round") {
      expect(round.agents[0]?.summary).toBe("Listed files");
      const progressThoughts = (round.agents[0]?.nestedItems ?? []).filter(
        (i) => i.kind === "thought",
      );
      expect(progressThoughts.length).toBe(2);
      expect(
        progressThoughts.some(
          (i) => i.kind === "thought" && i.content === "Reading package.json",
        ),
      ).toBe(true);
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

  it("resolveLiveSubagentRound builds provisional round from subagent activity", () => {
    const round = resolveLiveSubagentRound({
      liveThread: [],
      chatId: 1,
      activityItems: [
        {
          id: "delegation-1",
          type: "subagent_start",
          agent: "explore",
          agentType: "explore",
          label: "explore · api",
          status: "running",
          timestamp: 1,
          chatId: 1,
          roundId: "turn-1",
        },
        {
          id: "delegation-2",
          type: "subagent_start",
          agent: "research",
          agentType: "research",
          label: "research · web",
          status: "running",
          timestamp: 2,
          chatId: 1,
          roundId: "turn-1",
        },
      ],
    });
    expect(round?.kind).toBe("subagent_round");
    expect(round?.agents.length).toBe(2);
    expect(round?.status).toBe("running");
  });

  it("resolveLiveSubagentRound applies progress and nested tool_use from activity", () => {
    const round = resolveLiveSubagentRound({
      liveThread: [],
      chatId: 1,
      activityItems: [
        {
          id: "delegation-1",
          type: "subagent_start",
          agent: "explore",
          agentType: "explore",
          label: "explore · api",
          status: "running",
          timestamp: 1,
          chatId: 1,
          roundId: "turn-1",
        },
        {
          id: "delegation-1",
          type: "subagent_progress",
          preview: "Reading files… (api/README.md)…",
          label: "explore",
          status: "running",
          timestamp: 2,
          chatId: 1,
          roundId: "turn-1",
        },
        {
          id: "sub-tool-1",
          type: "tool_use",
          toolName: "read_file",
          status: "done",
          label: "Read files (api/README.md)…",
          parentDelegationId: "delegation-1",
          detail: JSON.stringify({
            success: false,
            error: "file_not_found",
            path: "api/README.md",
          }),
          timestamp: 3,
          chatId: 1,
          roundId: "turn-1",
        },
      ],
    });
    const agent = round?.agents.find((a) => a.id === "delegation-1");
    expect(agent?.summary).toContain("README");
    expect(agent?.nestedItems.some((i) => i.kind === "tool")).toBe(true);
  });

  it("pickSubagentDisplayLabel prefers scoped title over Agent team stub", () => {
    expect(
      pickSubagentDisplayLabel(
        "Agent team: Explore assigned",
        "explore · api",
      ),
    ).toBe("explore · api");
    expect(
      mergeSubAgentRunEntries(
        [
          {
            id: "a",
            agentType: "explore",
            label: "explore · api",
            status: "running",
            nestedItems: [],
          },
        ],
        [
          {
            id: "a",
            agentType: "explore",
            label: "Agent team: Explore assigned",
            status: "running",
            nestedItems: [],
          },
        ],
      )[0]?.label,
    ).toBe("explore · api");
  });

  it("pickSubagentDisplayLabel deprioritizes delegation-* ids", () => {
    expect(
      pickSubagentDisplayLabel(
        "delegation-1779123456789-abc",
        "Mapping: spacinsider-api",
      ),
    ).toBe("Mapping: spacinsider-api");
    expect(isDelegationIdLabel("delegation-1")).toBe(true);
    expect(isDelegationIdLabel("explore · api")).toBe(false);
  });

  it("resolveLiveSubagentRound uses scope label when nested tools only have delegation id", () => {
    const round = resolveLiveSubagentRound({
      liveThread: [],
      chatId: 1,
      activityItems: [
        {
          id: "delegation-1779",
          type: "tool_use",
          toolName: "read_file",
          status: "done",
          label: "Read README",
          parentDelegationId: "delegation-1779",
          agent: "explore",
          agentType: "explore",
          scope: "spacinsider-api",
          timestamp: 1,
          chatId: 1,
          roundId: "turn-1",
        },
      ],
    });
    const agent = round?.agents.find((a) => a.id === "delegation-1779");
    expect(agent?.label).toBe("Mapping: spacinsider-api");
    expect(resolveSubagentCardLabel(agent!)).toBe("Mapping: spacinsider-api");
  });

  it("mergeNestedToolActivityIntoSubagentRound stubs agent before subagent_start", () => {
    const tool: ActivityStreamItem = {
      id: "sub-tool-del-1-explore_folder-100",
      type: "tool_use",
      toolName: "explore_folder",
      label: "explore_folder",
      status: "running",
      parentDelegationId: "delegation-1",
      roundId: "turn-1",
      timestamp: 1,
      chatId: 1,
    };
    let items = mergeNestedToolActivityIntoSubagentRound(
      [],
      "delegation-1",
      tool,
    );
    expect(items[0]?.kind).toBe("subagent_round");
    const start: ActivityStreamItem = {
      id: "delegation-1",
      type: "subagent_start",
      label: "explore · api",
      status: "running",
      timestamp: 2,
      agent: "explore",
      agentType: "explore",
      roundId: "turn-1",
      chatId: 1,
    };
    items = mergeSubagentActivityIntoThread(items, start);
    const round = items[0];
    expect(round?.kind).toBe("subagent_round");
    if (round?.kind === "subagent_round") {
      expect(round.agents).toHaveLength(1);
      expect(round.agents[0]?.nestedItems).toHaveLength(1);
      expect(round.agents[0]?.nestedItems[0]?.kind).toBe("tool");
    }
  });

  it("resolveLiveSubagentRound unions done and running agents from activity", () => {
    const round = resolveLiveSubagentRound({
      liveThread: [],
      chatId: 1,
      activityItems: [
        {
          id: "delegation-1",
          type: "subagent_complete",
          agent: "explore",
          agentType: "explore",
          label: "explore · a",
          status: "done",
          result: "Done A",
          timestamp: 1,
          chatId: 1,
          roundId: "turn-1",
        },
        {
          id: "delegation-2",
          type: "subagent_start",
          agent: "research",
          agentType: "research",
          label: "research · b",
          status: "running",
          timestamp: 2,
          chatId: 1,
          roundId: "turn-1",
        },
      ],
    });
    expect(round?.agents).toHaveLength(2);
    expect(round?.agents.some((a) => a.id === "delegation-1" && a.status === "done")).toBe(
      true,
    );
    expect(
      round?.agents.some((a) => a.id === "delegation-2" && a.status === "running"),
    ).toBe(true);
    expect(round?.status).toBe("running");
  });

  it("resolveLiveSubagentRound merges thread nestedItems with activity status", () => {
    const liveThread = [
      {
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
                kind: "tool" as const,
                id: "sub-tool-1",
                toolName: "read_file",
                summary: "Reading config…",
                status: "done" as const,
                ts: 2,
              },
            ],
          },
        ],
      },
    ];
    const round = resolveLiveSubagentRound({
      liveThread,
      chatId: 1,
      activityItems: [
        {
          id: "delegation-1",
          type: "subagent_complete",
          agent: "explore",
          label: "explore",
          status: "done",
          timestamp: 3,
          chatId: 1,
          roundId: "turn-1",
        },
      ],
    });
    expect(round?.agents[0]?.status).toBe("done");
    expect(round?.agents[0]?.nestedItems).toHaveLength(1);
  });

  it("nested explore_folder activity builds file_list expand", () => {
    const detail = JSON.stringify({
      success: true,
      items: [
        { path: "./api/app.py", type: "file" },
        { path: "./api/tests", type: "dir" },
      ],
      total: 2,
    });
    const item = streamThreadItemFromActivity({
      id: "sub-tool-del-1-explore_folder-99",
      type: "tool_use",
      toolName: "explore_folder",
      label: "explore_folder",
      status: "done",
      detail,
      parentDelegationId: "delegation-1",
      timestamp: 1,
      chatId: 1,
    });
    expect(item?.kind).toBe("tool");
    if (item?.kind === "tool") {
      expect(item.expand?.kind).toBe("file_list");
    }
  });

  it("streamThreadItemFromActivity uses activity label while running", () => {
    const item = streamThreadItemFromActivity({
      id: "sub-tool-1",
      type: "tool_use",
      toolName: "get_repo_overview",
      status: "running",
      label: "Mapping repository… (api/)…",
      parentDelegationId: "delegation-1",
      timestamp: 1,
      chatId: 1,
    });
    expect(item?.kind).toBe("tool");
    if (item?.kind === "tool") {
      expect(item.summary).toContain("api/");
    }
  });

  it("subagent_start label uses scope not preset", () => {
    const start: ActivityStreamItem = {
      id: "delegation-1",
      type: "subagent_start",
      label: "explore · spacinsider-api",
      status: "running",
      timestamp: 1,
      agent: "explore",
      agentType: "explore",
      scope: "spacinsider-api",
      roundId: "turn-1",
      chatId: 1,
    };
    const items = mergeSubagentActivityIntoThread([], start);
    const round = items[0];
    expect(round?.kind).toBe("subagent_round");
    if (round?.kind === "subagent_round") {
      expect(round.agents[0]?.label).toBe("explore · spacinsider-api");
      expect(round.agents[0]?.scope).toBe("spacinsider-api");
    }
  });

  it("mergeSubAgentRunEntries preserves nested items from primary", () => {
    const merged = mergeSubAgentRunEntries(
      [
        {
          id: "a",
          agentType: "explore",
          label: "explore",
          status: "running",
          nestedItems: [
            {
              kind: "tool",
              id: "t1",
              toolName: "read_file",
              summary: "Read",
              status: "done",
              ts: 1,
            },
          ],
        },
      ],
      [
        {
          id: "a",
          agentType: "explore",
          label: "explore",
          status: "done",
          nestedItems: [],
        },
      ],
    );
    expect(merged[0]?.status).toBe("done");
    expect(merged[0]?.nestedItems).toHaveLength(1);
  });

  it("splitInterleavedAroundDelegates splits at first delegate tool", () => {
    const { before, after } = splitInterleavedAroundDelegates([
      { type: "thought", content: "plan" },
      { type: "markdown", content: "dispatching" },
      { type: "tool", id: "1", toolName: "spawn_sub_agent", status: "running" },
      { type: "tool", id: "2", toolName: "read_file", status: "success" },
      { type: "markdown", content: "done" },
    ]);
    expect(before).toHaveLength(2);
    expect(after).toHaveLength(2);
    expect(after.some((p) => p.type === "tool" && p.toolName === "spawn_sub_agent")).toBe(
      false,
    );
  });

  it("synthesizeSubagentRoundFromParts includes failed spawn_sub_agent results", () => {
    const round = synthesizeSubagentRoundFromParts([
      {
        type: "tool",
        id: "spawn-1",
        toolName: "spawn_sub_agent",
        status: "error",
        resultText:
          "A sub-agent with the same agent, preset, and scope is already running.",
        args: { default_focus_path: "/repo/a" },
      },
    ]);
    expect(round?.kind).toBe("subagent_round");
    expect(round?.agents).toHaveLength(1);
    expect(round?.agents[0]?.status).toBe("error");
    expect(round?.agents[0]?.summary).toContain("already running");
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
