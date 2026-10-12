import { describe, expect, it } from "vitest";
import { previewLines, toCells, toolResultText, toolTarget } from "@/cli/agent/transcript";

/** The exact shape the agent streamed in a real run (captured 2026-10-01). */
const assistant = [
  '<atlarix-tool-call tool="grep" status="running">',
  '{"pattern":"spike-marker"}',
  "</atlarix-tool-call>",
  '<atlarix-tool-result tool="grep" status="complete">',
  '{"success":true,"result":"1 match(es)"}',
  "</atlarix-tool-result>",
  '<atlarix-tool-call tool="run_command" status="running">',
  '{"command":"echo ok > out.txt","description":"write"}',
  "</atlarix-tool-call>",
  "Done — both returned.",
].join("\n");

describe("toCells", () => {
  it("splits an assistant message into tool lines and prose, in order", () => {
    const cells = toCells([
      { id: 1, role: "user", content: "find the marker" },
      { id: 2, role: "assistant", content: assistant },
    ]);
    expect(cells.map((c) => c.kind)).toEqual(["user", "tool", "tool", "markdown"]);
    const [, grep, run, prose] = cells;
    expect(grep).toMatchObject({ kind: "tool", tool: { verb: "Search", target: '"spike-marker"', status: "success" } });
    // The desktop's parser treats a call followed by later text as finished: the
    // turn moved on. The CLI shows what the app shows.
    expect(run).toMatchObject({ kind: "tool", tool: { verb: "Run", target: "echo ok > out.txt", status: "success" } });
    expect(prose).toMatchObject({ kind: "markdown", text: "Done — both returned." });
  });

  it("a call at the end of a streaming message is still running", () => {
    const streaming = assistant.split("Done")[0]!;
    const last = toCells([{ id: 2, role: "assistant", content: streaming }], { streaming: true }).at(-1);
    expect(last).toMatchObject({ kind: "tool", tool: { verb: "Run", status: "running" } });
  });

  it("keeps ids stable as the same message grows", () => {
    const first = toCells([{ id: 2, role: "assistant", content: assistant.split("Done")[0]! }], { streaming: true });
    const later = toCells([{ id: 2, role: "assistant", content: assistant }]);
    expect(later.slice(0, first.length).map((c) => c.id)).toEqual(first.map((c) => c.id));
  });

  it("ignores empty and non-chat roles", () => {
    expect(toCells([{ id: 1, role: "user", content: "  " }, { id: 2, role: "tool", content: "x" }])).toEqual([]);
  });
});

describe("toolTarget", () => {
  it("names the path, pattern or command", () => {
    expect(toolTarget("read_file", { path: "src/a.ts" })).toBe("src/a.ts");
    expect(toolTarget("grep", { pattern: "foo", path: "src" })).toBe('"foo" in src');
    expect(toolTarget("run_command", { command: "npm test" })).toBe("npm test");
    expect(toolTarget("unknown_tool", { x: 1 })).toBe("");
  });
});

describe("previewLines", () => {
  it("takes the first lines and counts the rest", () => {
    expect(previewLines("a\nb\nc\nd\n", 2)).toEqual({ lines: ["a", "b"], more: 2 });
  });
});

describe("placeSteers", () => {
  it("draws a delivered steer where it arrived inside the answer, not above it", async () => {
    const { placeSteers } = await import("@/cli/agent/transcript");
    const answer = [
      '<atlarix-tool-call tool="run_command" status="running">',
      '{"command":"sleep 4"}',
      "</atlarix-tool-call>",
      '<atlarix-tool-result tool="run_command" status="complete">',
      '{"success":true,"output":"","exitCode":0}',
      "</atlarix-tool-result>",
    ].join("\n");
    const later = answer + "\nUsing the redis store as you asked.";
    const messages = [
      { id: 1, role: "user", content: "start" },
      { id: 5, role: "user", content: "STEER-ALPHA" }, // inserted in front of the answer
      { id: 2, role: "assistant", content: later },
    ];
    const cells = placeSteers(messages, new Map([["5", { messageId: "5", assistantId: "2", offset: answer.length }]]));
    expect(cells.map((c) => (c.kind === "user" ? `user:${c.text}` : c.kind))).toEqual([
      "user:start",
      "tool",
      "user:STEER-ALPHA",
      "markdown",
    ]);
  });
});

describe("a turn that ended on questions", () => {
  it("does not show the pending-questions marker (the CLI asks them in a dialog)", () => {
    const cells = toCells([
      { id: 1, role: "user", content: "pick a color" },
      {
        id: 2,
        role: "assistant",
        content: 'Let me check.\n\n<!-- atlarix-questions:{"questionId":"uq_1","questions":[{"question":"Which color?"}]} -->',
      },
    ]);
    expect(cells.map((c) => ("text" in c ? c.text : ""))).toEqual(["pick a color", "Let me check."]);
  });
});

describe("sub-agents", () => {
  it("nest their tool calls under the task call that started them, in call order", async () => {
    const { withDelegations, activityToolLine } = await import("@/cli/agent/transcript");
    const cells: Parameters<typeof withDelegations>[0] = [
      { kind: "tool", id: "9:t:task_0", tool: { id: "task_0", verb: "Agent", target: "find the auth code", status: "running" } },
      { kind: "tool", id: "9:t:task_1", tool: { id: "task_1", verb: "Agent", target: "read the tests", status: "success", summary: "{\"success\":true}" } },
    ];
    const out = withDelegations(cells, [
      {
        id: "d1",
        assistantId: "9",
        index: 0,
        status: "running",
        progress: "Searching for login",
        children: [activityToolLine({ id: "x", toolName: "grep", status: "success", toolArgs: { pattern: "login" } })],
      },
      { id: "d2", assistantId: "9", index: 1, status: "success", summary: "Tests cover login only.\nmore", children: [] },
    ]);
    const [a, b] = out as Array<Extract<(typeof out)[number], { kind: "tool" }>>;
    expect(a!.tool.children?.[0]).toMatchObject({ verb: "Search", target: '"login"', status: "success" });
    expect(a!.tool.progress).toBe("Searching for login");
    expect(b!.tool.summary).toBe("Tests cover login only.");
    expect(b!.tool.progress).toBeUndefined();
  });
});

describe("parallel calls of one tool", () => {
  it("each result lands on its own call — by call id, or oldest-open first for older messages", async () => {
    const { parseAssistantMessageParts } = await import("@/lib/chat/assistant-message-parts");
    const call = (p: string, id?: string) =>
      `<atlarix-tool-call tool="read_file"${id ? ` call="${id}"` : ""} status="running">\n{"path":"${p}"}\n</atlarix-tool-call>\n`;
    const result = (p: string, id?: string) =>
      `<atlarix-tool-result tool="read_file"${id ? ` call="${id}"` : ""} status="complete">\nFile: ${p}\n</atlarix-tool-result>\n`;
    const pairs = (content: string) =>
      parseAssistantMessageParts(content, false)
        .filter((p) => p.type === "tool")
        .map((p) => [(p as { args: { path: string } }).args.path, (p as { resultText?: string }).resultText]);
    expect(pairs(call("a.md") + call("b.md") + result("a.md") + result("b.md"))).toEqual([
      ["a.md", "File: a.md"],
      ["b.md", "File: b.md"],
    ]);
    expect(pairs(call("a.md", "c1") + call("b.md", "c2") + result("b.md", "c2") + result("a.md", "c1"))).toEqual([
      ["a.md", "File: a.md"],
      ["b.md", "File: b.md"],
    ]);
  });
});

describe("braces in prose", () => {
  it("stay in their sentence and code fence", async () => {
    const cells = toCells([{ id: 1, role: "assistant", content: "Path: `recordings/{year}/items/{id}`.\n\n```json\n{\n  \"a\": 1\n}\n```" }]);
    expect(cells).toEqual([
      { kind: "markdown", id: "1:0", text: "Path: `recordings/{year}/items/{id}`.\n\n```json\n{\n  \"a\": 1\n}\n```" },
    ]);
  });
});

describe("edits and answers", () => {
  it("an edit's diff comes from its arguments, in place of 'Successfully wrote'", async () => {
    const { editDiff } = await import("@/cli/agent/transcript");
    const d = editDiff({ operation: "replace", edits: [{ old_content: "# Test\nintro", new_content: "# Test (edited)\nintro\nmore" }] })!;
    expect([d.added, d.removed]).toEqual([2, 1]);
    expect(d.lines.filter((l) => l.kind === "add").map((l) => l.text)).toEqual(["# Test (edited)", "more"]);
    expect(editDiff({ operation: "write", content: "a\nb\n" })).toMatchObject({ added: 2, removed: 0 });
    const cells = toCells([
      { id: 1, role: "assistant", content: '<atlarix-tool-call tool="edit_file" status="running">\n{"path":"a.md","operation":"write","content":"x\\ny\\n"}\n</atlarix-tool-call>\n<atlarix-tool-result tool="edit_file" status="complete">\n{"success":true,"result":"Successfully wrote a.md"}\n</atlarix-tool-result>\n' },
    ]);
    expect(cells[0]).toMatchObject({ kind: "tool", tool: { verb: "Edit", summary: "Added 2 lines" } });
  });

  it("answers to the agent's questions become an answers cell", () => {
    const cells = toCells([{ id: 2, role: "user", content: "***Q:*** Which db? → ***A:*** SQLite\n***Q:*** Auth? → ***A:*** No" }]);
    expect(cells).toEqual([{ kind: "answers", id: "2:u", pairs: [{ question: "Which db?", answer: "SQLite" }, { question: "Auth?", answer: "No" }] }]);
    expect(toCells([{ id: 3, role: "user", content: "what does ***Q:*** mean" }])[0]).toMatchObject({ kind: "user" });
  });
});

describe("chips and line numbers", () => {
  it("a message's placeholders and the app's stub tags become chips", async () => {
    const { userChips } = await import("@/cli/agent/transcript");
    expect(userChips("look at [Image #1] and [Pasted text #2 +40 lines]")).toEqual({
      text: "look at [Image #1] and [Pasted text #2 +40 lines]",
      chips: ["[Image #1]", "[Pasted text #2 +40 lines]"],
    });
    expect(userChips('fix this <atlarix-text-attachment filename="error.log" />')).toEqual({ text: "fix this", chips: ["[error.log]"] });
  });

  it("an edit's lines are numbered where its new text sits in the file", async () => {
    const { editDiff, locateBlocks } = await import("@/cli/agent/transcript");
    const d = editDiff({ operation: "replace", old_content: "b\nc", new_content: "b\nC" })!;
    const file = "a\nb\nC\nd\n";
    const starts = locateBlocks(d, file);
    expect(starts).toEqual([2]);
    const added = d.lines.find((l) => l.kind === "add")!;
    expect(starts[0]! - 1 + added.no!).toBe(3);
    expect(locateBlocks(d, "nothing like it")).toEqual([null]);
  });
});

describe("a sent paste", () => {
  it("shows what was pasted, not just the placeholder", () => {
    const body = Array.from({ length: 12 }, (_, i) => `pasted line ${i + 1}`).join("\n");
    const [cell] = toCells([{ id: 9, role: "user", content: "fix this [Pasted text #1 +12 lines]", modelContent: `fix this ${body}` }]);
    expect(cell).toMatchObject({ kind: "user", chips: ["[Pasted text #1 +12 lines]"] });
    expect((cell as { full?: string }).full).toContain("pasted line 12");
    // A message with no paste keeps no copy.
    const [plain] = toCells([{ id: 10, role: "user", content: "just text", modelContent: null }]);
    expect((plain as { full?: string }).full).toBeUndefined();
  });
});

describe("plan and background job lines say what happened", () => {
  it("names the plan operation and the job operation", () => {
    expect(toolTarget("plan", { operation: "update_step", step_index: 3, state: "done" })).toBe("step 3 → done");
    expect(toolTarget("plan", { operation: "write", title: "CLI smoke test" })).toBe("write · CLI smoke test");
    expect(toolTarget("background_jobs", { operation: "list" })).toBe("list");
  });

  it("reads the result inside the envelope, and never shows a cut-off envelope", () => {
    expect(toolResultText("plan", '{"success":true,"result":{"success":true,"progress":"2/4 steps done"}}').text).toBe("2/4 steps done");
    expect(toolResultText("background_jobs", '{"success":true,"result":{"count":0,"jobs":[]}}').text).toBe("none running");
    const cut = '{"success":true,"result":{"success":true,"planId":"deb8","planStatus":"plan","contentPreview":"This plan exists';
    expect(toolResultText("plan", cut).text).toBe("");
    expect(toolResultText("plan", '{"success":true,"result":{"message":"Plan saved.","x":"cut').text).toBe("Plan saved.");
  });
});

describe("a sub-agent's task call", () => {
  const msg = (result: string) => ({
    id: 9,
    role: "assistant",
    content:
      `<atlarix-tool-call tool="task" call="t1" status="running">\n{"description":"Map src/mini","prompt":"Read-only reconnaissance task."}\n</atlarix-tool-call>\n` +
      `<atlarix-tool-result tool="task" call="t1" status="complete">\n${result}\n</atlarix-tool-result>\n`,
  });
  const taskTool = (result: string) => {
    const cell = toCells([msg(result)]).find((c) => c.kind === "tool");
    return (cell as Extract<ReturnType<typeof toCells>[number], { kind: "tool" }>).tool;
  };

  it("in the background reads as running, never as its raw envelope", () => {
    const t = taskTool('<task id="205e9aef" state="running">\nStarted in the background.\n</task>');
    expect(t.status).toBe("running");
    expect(t.summary).toBe("running in the background");
    expect(t.output ?? "").not.toContain("<task");
  });

  it("when done shows its report, not the tag", () => {
    const t = taskTool('<task id="205e9aef" state="completed">\nsrc/mini has 12 files; the entry is index.ts.\n</task>');
    expect(t.status).toBe("success");
    expect(t.summary).toBe("src/mini has 12 files; the entry is index.ts.");
  });
});

describe("what a step's result line says", () => {
  const line = (tool: string, args: object, result: string) => {
    const content =
      `<atlarix-tool-call tool="${tool}" call="c1" status="running">\n${JSON.stringify(args)}\n</atlarix-tool-call>\n` +
      `<atlarix-tool-result tool="${tool}" call="c1" status="complete">\n${result}\n</atlarix-tool-result>\n`;
    const cell = toCells([{ id: 3, role: "assistant", content }]).find((c) => c.kind === "tool");
    return (cell as Extract<ReturnType<typeof toCells>[number], { kind: "tool" }>).tool.summary;
  };

  it("a read says which lines it read", () => {
    expect(line("read_file", { path: "a.ts" }, "File: a.ts\nLines: 1-240 of 3641\n\n1\tx")).toBe("lines 1–240 of 3641");
    expect(line("read_file", { path: "b.ts" }, "File: b.ts\nLines: 1-80 (complete)\n\n1\tx")).toBe("80 lines");
  });

  it("a find says how many files, without the dangling colon", () => {
    expect(line("glob", { pattern: "**/*.ts" }, "Found 500 file(s) (newest first):\nsrc/a.ts")).toBe("500 files");
  });
});
