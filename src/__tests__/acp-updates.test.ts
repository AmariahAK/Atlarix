/**
 * `atlarix acp`: the CLI transcript as ACP session/update deltas (src/cli/acp/updates.ts).
 * An editor draws what it is sent and cannot take it back, so each update must
 * be exactly the change: the new tail of a message, a tool call once, then its
 * status changes.
 */
import { describe, expect, it } from "vitest";
import { diffUpdates, toolKind, toolNameFromId, type Emitted } from "@/cli/acp/updates";
import type { Cell } from "@/cli/agent/transcript";

const md = (id: string, text: string): Cell => ({ kind: "markdown", id, text });

describe("diffUpdates", () => {
  it("sends only the new tail of a streaming message", () => {
    const e: Emitted = new Map();
    expect(diffUpdates([md("m:0", "Hel")], e)).toEqual([
      { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Hel" } },
    ]);
    expect(diffUpdates([md("m:0", "Hello world")], e)).toEqual([
      { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "lo world" } },
    ]);
    expect(diffUpdates([md("m:0", "Hello world")], e)).toEqual([]);
  });

  it("sends nothing for a rewrite it cannot take back, and carries on from it", () => {
    const e: Emitted = new Map();
    diffUpdates([md("m:0", "Hello world")], e);
    expect(diffUpdates([md("m:0", "Hello")], e)).toEqual([]);
    expect(diffUpdates([md("m:0", "Hello again")], e)).toEqual([
      { sessionUpdate: "agent_message_chunk", content: { type: "text", text: " again" } },
    ]);
  });

  it("an answer that replaces the live thought at the same id is still sent", () => {
    const e: Emitted = new Map();
    diffUpdates([{ kind: "thought", id: "m:0", text: "Quick" }], e);
    expect(diffUpdates([md("m:0", "It exports check().")], e)).toEqual([
      { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "It exports check()." } },
    ]);
  });

  it("thoughts go out as thought chunks", () => {
    const e: Emitted = new Map();
    const [u] = diffUpdates([{ kind: "thought", id: "m:0", text: "hmm" }], e);
    expect(u).toEqual({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "hmm" } });
  });

  it("a tool call goes out once, then as status updates; an edit carries its diff", () => {
    const e: Emitted = new Map();
    const running: Cell = {
      kind: "tool",
      id: "m:t:edit_file_1",
      tool: { id: "edit_file_1", verb: "Edit", target: "src/a.ts", status: "running" },
    };
    const [call] = diffUpdates([running], e);
    expect(call).toMatchObject({
      sessionUpdate: "tool_call",
      toolCallId: "m:t:edit_file_1",
      title: "Edit src/a.ts",
      kind: "edit",
      status: "in_progress",
      locations: [{ path: "src/a.ts" }],
    });
    expect(diffUpdates([running], e)).toEqual([]);
    const done: Cell = {
      ...running,
      tool: {
        ...running.tool,
        status: "success",
        diff: {
          added: 1,
          removed: 1,
          lines: [
            { kind: "context", text: "a" },
            { kind: "remove", text: "b" },
            { kind: "add", text: "c" },
          ],
          blocks: ["a\nc"],
        },
      },
    } as Cell;
    const [upd] = diffUpdates([done], e);
    expect(upd).toMatchObject({ sessionUpdate: "tool_call_update", toolCallId: "m:t:edit_file_1", status: "completed" });
    expect((upd as { content: unknown[] }).content[0]).toEqual({
      type: "diff",
      path: "src/a.ts",
      oldText: "a\nb",
      newText: "a\nc",
    });
  });

  it("a failed command reports failed with its error text, and no file location", () => {
    const e: Emitted = new Map();
    const [u] = diffUpdates(
      [
        {
          kind: "tool",
          id: "m:t:run_command_2",
          tool: { id: "x", verb: "Run", target: "npm test", status: "error", error: "exit 1" },
        },
      ],
      e,
    );
    expect(u).toMatchObject({ sessionUpdate: "tool_call", kind: "execute", status: "failed" });
    expect(u).not.toHaveProperty("locations");
    expect((u as { content: unknown[] }).content).toEqual([{ type: "content", content: { type: "text", text: "exit 1" } }]);
  });

  it("the user's own messages only on replay (a live editor already shows them)", () => {
    const user: Cell = { kind: "user", id: "u:1", text: "fix it" };
    expect(diffUpdates([user], new Map())).toEqual([]);
    expect(diffUpdates([user], new Map(), { replay: true })).toEqual([
      { sessionUpdate: "user_message_chunk", content: { type: "text", text: "fix it" } },
    ]);
  });

  it("an error notice is said once; footers are silent", () => {
    const e: Emitted = new Map();
    const cells: Cell[] = [
      { kind: "notice", id: "n:1", level: "error", text: "Out of credit" },
      { kind: "footer", id: "f:1", text: "Build · Auto · 3s" },
    ];
    expect(diffUpdates(cells, e)).toEqual([
      { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "\n\nOut of credit" } },
    ]);
    expect(diffUpdates(cells, e)).toEqual([]);
  });
});

describe("tool names and kinds", () => {
  it("reads the tool name off a cell id", () => {
    expect(toolNameFromId("abc:t:read_file_3")).toBe("read_file");
    expect(toolNameFromId("abc:t:web_search")).toBe("web_search");
    expect(toolNameFromId("abc:0")).toBe("");
  });

  it("maps tools to ACP kinds", () => {
    expect(toolKind("read_file")).toBe("read");
    expect(toolKind("grep")).toBe("search");
    expect(toolKind("run_command")).toBe("execute");
    expect(toolKind("read_url")).toBe("fetch");
    expect(toolKind("send_message")).toBe("other");
  });
});

describe("your messages carry their stored ids (Atlarix's own extension)", () => {
  const user = (id: string, text: string): Cell => ({ kind: "user", id, text });

  it("live, a saved message comes as an echo that names its id; one not saved yet sends nothing", () => {
    const e: Emitted = new Map();
    expect(diffUpdates([user("tmp:u", "hi")], e, { ids: true })).toEqual([]);
    expect(diffUpdates([user("42:u", "hi")], e, { ids: true })).toEqual([
      { sessionUpdate: "user_message_chunk", content: { type: "text", text: "hi" }, _meta: { atlarix: { messageId: 42, echo: true } } },
    ]);
  });

  it("replayed, each message is drawn with its id; other editors get no ids", () => {
    expect(diffUpdates([user("7:u", "first")], new Map(), { replay: true, ids: true })).toEqual([
      { sessionUpdate: "user_message_chunk", content: { type: "text", text: "first" }, _meta: { atlarix: { messageId: 7 } } },
    ]);
    expect(diffUpdates([user("7:u", "first")], new Map(), { replay: true })).toEqual([
      { sessionUpdate: "user_message_chunk", content: { type: "text", text: "first" } },
    ]);
    // A message from another session's text segment is not yours to go back to.
    expect(diffUpdates([user("7:pu0", "theirs")], new Map(), { ids: true })).toEqual([]);
  });
});

/**
 * A sub-agent is one `task` call that stays running while it works. ACP has no
 * notion of a sub-agent, so its own calls, what it has used and its report go
 * in that call's body (any editor draws it), and in `_meta.atlarix.subagent`
 * for Atlarix's extension, which draws the app's panel from it.
 */
describe("a sub-agent's task call", () => {
  const task = (over: Partial<Extract<Cell, { kind: "tool" }>["tool"]> = {}): Cell => ({
    kind: "tool",
    id: "7:t:task_0",
    tool: {
      id: "task_0",
      verb: "Agent",
      target: "Callers of refreshSession",
      status: "running",
      progress: "Reading the session code",
      children: [{ id: "c1", verb: "Searched", target: "refreshSession", status: "success" }],
      agent: { label: "Callers of refreshSession", startedAt: 1_000, tokens: 1_200 },
      ...over,
    },
  });
  const body = (u: unknown) =>
    ((u as { content?: Array<{ content: { text: string } }> }).content ?? []).map((c) => c.content.text).join("\n");

  it("streams what it is doing, each of its calls and what it has used", () => {
    const [u] = diffUpdates([task()], new Map());
    expect(u).toMatchObject({ sessionUpdate: "tool_call", kind: "think", status: "in_progress" });
    expect(body(u)).toContain("Reading the session code");
    expect(body(u)).toContain("Searched refreshSession");
    expect(body(u)).toContain("1 tool · 1.2k tokens");
    expect((u as { _meta?: { atlarix?: { subagent?: unknown } } })._meta?.atlarix?.subagent).toMatchObject({
      label: "Callers of refreshSession",
      status: "running",
      startedAt: 1_000,
      tools: [{ verb: "Searched", target: "refreshSession", status: "success" }],
    });
  });

  it("re-sends while it stays running: a new call, a new step, more tokens", () => {
    const e: Emitted = new Map();
    diffUpdates([task()], e);
    expect(diffUpdates([task()], e)).toEqual([]);
    const more = task({
      children: [
        { id: "c1", verb: "Searched", target: "refreshSession", status: "success" },
        { id: "c2", verb: "Read", target: "src/auth/session.ts", status: "running" },
      ],
    });
    const [u] = diffUpdates([more], e);
    expect(u).toMatchObject({ sessionUpdate: "tool_call_update", status: "in_progress" });
    expect(body(u)).toContain("Read src/auth/session.ts");
    // Tokens re-send in steps of 1k, not on every token.
    const moreTool = (more as Extract<Cell, { kind: "tool" }>).tool;
    expect(diffUpdates([task({ ...moreTool, agent: { tokens: 1_900 } })], e)).toEqual([]);
  });

  it("ends with its report", () => {
    const e: Emitted = new Map();
    diffUpdates([task()], e);
    const [u] = diffUpdates([task({ status: "success", progress: undefined, output: "The proxy has no clock leeway." })], e);
    expect(u).toMatchObject({ sessionUpdate: "tool_call_update", status: "completed" });
    expect(body(u)).toContain("The proxy has no clock leeway.");
    expect(body(u)).not.toContain("Reading the session code");
  });
});

describe("a reply whose position in the message moves", () => {
  it("is not sent again when the saved message lays its parts out differently", () => {
    // Live: the reply is part 3 of message 70. Saved: a tool part is gone and it is part 2.
    const e: Emitted = new Map();
    diffUpdates([md("70:3", "Both sub-agents reported: two files.")], e);
    expect(diffUpdates([md("70:2", "Both sub-agents reported: two files.")], e)).toEqual([]);
    // It keeps streaming under its new key: only the new tail goes out.
    expect(diffUpdates([md("70:2", "Both sub-agents reported: two files. Done.")], e)).toEqual([
      { sessionUpdate: "agent_message_chunk", content: { type: "text", text: " Done." } },
    ]);
  });

  it("still sends a different reply that took a vacated position", () => {
    const e: Emitted = new Map();
    diffUpdates([md("70:3", "First answer.")], e);
    expect(diffUpdates([md("70:2", "Something else entirely.")], e)).toEqual([
      { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Something else entirely." } },
    ]);
  });

  it("never borrows from another message", () => {
    const e: Emitted = new Map();
    diffUpdates([md("70:3", "Same words.")], e);
    expect(diffUpdates([md("71:0", "Same words.")], e)).toHaveLength(1);
  });
});

describe("what woke the agent", () => {
  it("goes to the editor as a finished step, once", () => {
    const e: Emitted = new Map();
    const note: Cell = { kind: "notice", id: "wake:k1", level: "info", text: "◇ Map src/mini finished · 72s" };
    expect(diffUpdates([note], e)).toEqual([
      { sessionUpdate: "tool_call", toolCallId: "wake:k1", title: "Map src/mini finished · 72s", kind: "other", status: "completed" },
    ]);
    expect(diffUpdates([note], e)).toEqual([]);
  });
});

describe("what you approved", () => {
  it("goes to the editor as a finished step, once", () => {
    const e: Emitted = new Map();
    const note: Cell = {
      kind: "notice",
      id: "approved:op1",
      level: "info",
      text: "✓ You approved Atlarix to always run commands that start with `npm` in this folder",
    };
    expect(diffUpdates([note], e)).toEqual([
      {
        sessionUpdate: "tool_call",
        toolCallId: "approved:op1",
        title: "You approved Atlarix to always run commands that start with `npm` in this folder",
        kind: "other",
        status: "completed",
      },
    ]);
    expect(diffUpdates([note], e)).toEqual([]);
  });
});

describe("a background sub-agent's report", () => {
  it("is what the agent said (or why it failed), not the call's start envelope", async () => {
    const { diffUpdates } = await import("@/cli/acp/updates");
    const cell = {
      kind: "tool" as const,
      id: "1:t:task_0",
      tool: {
        id: "task_0",
        verb: "Agent",
        target: "Largest files in src/mini",
        status: "error" as const,
        output: "Background sub-agent started. You'll receive its result automatically when it finishes.",
        agent: { label: "explore", report: "The model provider returned no output (rate limited)." },
      },
    };
    const updates = diffUpdates([cell as never], new Map());
    const meta = JSON.stringify(updates);
    expect(meta).toContain("The model provider returned no output (rate limited).");
    expect(meta).not.toContain("Background sub-agent started");
  });
});
