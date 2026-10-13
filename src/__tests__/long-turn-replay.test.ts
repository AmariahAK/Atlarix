/**
 * A long agent turn, streamed, as the CLI and the editors see it.
 *
 * Found on a real turn (2026-10-12): the parser numbered tool calls afresh in
 * every batch of tags, so one message had five `run_command_0`. The CLI and
 * ACP key cells by that name; the copies overwrote each other and were re-sent
 * with every chunk, and each re-send ended the reply in the editor — replies
 * came out as "This project has" / "an" / "unusually…", and thinking as a column
 * of empty "Thought for 1s". The fixture has the same shape: tool batches split
 * by thinking and prose, parallel calls, results out of order.
 */
import { describe, expect, it } from "vitest";
import { diffUpdates, type Emitted } from "@/cli/acp/updates";
import { toCells } from "@/cli/agent/transcript";
import { parseAssistantMessageParts } from "@/lib/chat/assistant-message-parts";

const call = (tool: string, id: string, args: object) =>
  `<atlarix-tool-call tool="${tool}" call="${id}" status="running">\n${JSON.stringify(args)}\n</atlarix-tool-call>\n`;
const result = (tool: string, id: string, text: string) =>
  `<atlarix-tool-result tool="${tool}" call="${id}" status="complete">\n${text}\n</atlarix-tool-result>\n`;

const TURN = [
  "<think>Start by listing the folder and reading the overview.</think>",
  call("glob", "c1", { pattern: "**/*.md" }),
  result("glob", "c1", "README.md\ndocs/LOG.md"),
  call("read_file", "c2", { path: "README.md" }),
  result("read_file", "c2", "# Demo"),
  "<think>Now the build and the routes, in parallel.</think>",
  call("run_command", "c3", { command: "npm run build" }),
  call("run_command", "c4", { command: "ls app" }),
  call("run_command", "c5", { command: "git log -1" }),
  result("run_command", "c5", "abc123 last commit"),
  result("run_command", "c3", "build ok"),
  result("run_command", "c4", "37 routes"),
  "This project has an unusually detailed engineering log. Let me read the rest of it.",
  call("read_file", "c6", { path: "docs/LOG.md" }),
  result("read_file", "c6", "lots of history"),
  "<think>Check the services next.</think>",
  call("run_command", "c7", { command: "cat compose.yml" }),
  result("run_command", "c7", "api, pg, redis"),
  "## Overview\n\n- Next.js 15, React 19\n- ~37 routes\n\n```graph\n{\"nodes\":[{\"id\":\"api\",\"name\":\"api\"},{\"id\":\"pg\",\"name\":\"pg\"}],\n\"edges\":[{\"source\":\"api\",\"target\":\"pg\"}]}\n```\n",
].join("");

describe("a long turn", () => {
  it("gives every tool call its own id, and every result finds its own call", () => {
    const parts = parseAssistantMessageParts(TURN, false);
    const tools = parts.filter((p) => p.type === "tool") as Array<{ id: string; toolName: string; resultText?: string; args?: { command?: string } }>;
    const ids = tools.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.filter((i) => i.startsWith("run_command_"))).toEqual(["run_command_0", "run_command_1", "run_command_2", "run_command_3"]);
    // Out-of-order results land on the call that asked for them.
    const byCommand = Object.fromEntries(tools.filter((t) => t.args?.command).map((t) => [t.args!.command, t.resultText]));
    expect(byCommand["npm run build"]).toBe("build ok");
    expect(byCommand["ls app"]).toBe("37 routes");
    expect(byCommand["git log -1"]).toBe("abc123 last commit");
  });

  it("keeps a diagram's JSON whole inside its fence", () => {
    const md = parseAssistantMessageParts(TURN, false).filter((p) => p.type === "markdown").map((p) => (p as { content: string }).content).join("\n");
    expect(md).toContain('"edges":[{"source":"api","target":"pg"}]');
  });

  it("streamed chunk by chunk, sends each reply as one growing message and never re-sends a finished tool", () => {
    const e: Emitted = new Map();
    const seen: Array<{ kind: string; id?: string; text?: string }> = [];
    for (let i = 7; i <= TURN.length; i += 7) {
      const cells = toCells([{ id: 1, role: "assistant", content: TURN.slice(0, i) }], { streaming: true });
      const keys = cells.map((c) => `${c.kind}:${c.id}`);
      expect(new Set(keys).size).toBe(keys.length);
      for (const u of diffUpdates(cells, e)) {
        seen.push({
          kind: u.sessionUpdate,
          id: (u as { toolCallId?: string }).toolCallId,
          text: (u as { content?: { text?: string } }).content?.text,
        });
      }
    }
    // No half-written tag ever shows up as reply or thought text.
    const text = seen.filter((u) => u.kind === "agent_message_chunk" || u.kind === "agent_thought_chunk").map((u) => u.text ?? "");
    const leaked = text.filter((t) => /<\/?(t|th|thi|thin|think|atlarix)[\w-]*$|^[^<]*<$/.test(t));
    expect(leaked).toEqual([]);
    // Tools are updated as their results stream in, not re-sent on every chunk:
    // before the fix this turn sent hundreds (every tool, every chunk).
    const toolUpdates = seen.filter((u) => u.kind === "tool_call_update").length;
    const tools = new Set(seen.filter((u) => u.kind === "tool_call").map((u) => u.id)).size;
    expect(tools).toBe(7);
    expect(toolUpdates).toBeLessThan(tools * 6);
    // The prose comes through whole: its words in order, once.
    const prose = text.join("");
    expect(prose.split("This project has an unusually detailed engineering log.").length - 1).toBe(1);
  });
});

describe("a reply that quotes a tool's JSON", () => {
  const QUOTED = [
    "4. Read the missing file — failed, as expected. The tool returned a clean structured error:\n\n```json\n",
    '{ "success": false, "error": "file_not_found", "message": "No file at src/x.ts", "path": "src/x.ts" }\n',
    "```\n\n**5. Run `ls /nope` — failed, as expected.** The pattern worth noting: errors come back as data.\n",
  ].join("");

  it("stays one reply, with no step made from the quote", () => {
    const parts = parseAssistantMessageParts(QUOTED, false);
    expect(parts.filter((p) => p.type === "tool")).toEqual([]);
    const md = parts.filter((p) => p.type === "markdown");
    expect(md).toHaveLength(1);
    expect((md[0] as { content: string }).content).toContain('"error": "file_not_found"');
    expect((md[0] as { content: string }).content).toContain("**5. Run");
  });

  it("while streaming, too, and a bare result outside a fence keeps one id across chunks", () => {
    for (let i = 5; i <= QUOTED.length; i += 5) {
      expect(parseAssistantMessageParts(QUOTED.slice(0, i), true).filter((p) => p.type === "tool")).toEqual([]);
    }
    const bare = 'Done.\n{"success":true,"result":"Found 3 matches"}\nThen more text.';
    const a = parseAssistantMessageParts(bare, false).filter((p) => p.type === "tool").map((p) => p.id);
    const b = parseAssistantMessageParts(bare, false).filter((p) => p.type === "tool").map((p) => p.id);
    expect(a).toEqual(b);
  });
});

describe("the plan marker", () => {
  it("is never sent as text while it is still being written", () => {
    const reply = "Plan ready.\n\n<!-- atlarix-plan-artifact:0006e76b-24c6-4e3a-9f00-1234567890ab -->\n\nSwitch to **Build** when you want it implemented.";
    const e: Emitted = new Map();
    let sent = "";
    for (let i = 1; i <= reply.length; i++) {
      const cells = toCells([{ id: 1, role: "assistant", content: reply.slice(0, i) }], { streaming: i < reply.length });
      for (const u of diffUpdates(cells, e)) {
        if (u.sessionUpdate === "agent_message_chunk") sent += (u as { content: { text: string } }).content.text;
      }
    }
    expect(sent).not.toContain("<!");
    expect(sent).not.toContain("atlarix-plan-artifact");
    expect(sent).toContain("Switch to **Build** when you want it implemented.");
  });
});
