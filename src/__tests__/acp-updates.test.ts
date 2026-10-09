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
