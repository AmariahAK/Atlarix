/**
 * `/import --from claude|codex|opencode`: each tool's own session format,
 * read into a portable session (src/cli/sessions/importers.ts). Fixtures are
 * the shapes those tools write today (Claude Code jsonl, Codex rollout jsonl,
 * opencode's session/message/part rows).
 */
import { describe, expect, it } from "vitest";
import { claudeProjectDirName, parseClaudeCode, parseCodex, parseOpencode } from "@/cli/sessions/importers";

const j = (o: unknown) => JSON.stringify(o);

describe("importers", () => {
  it("Claude Code: the title, the user's words, tools with results; meta and commands skipped", () => {
    const doc = parseClaudeCode(
      [
        j({ type: "ai-title", aiTitle: "Fix the flaky test" }),
        j({ type: "user", isMeta: true, message: { role: "user", content: "<command-name>/clear</command-name>" } }),
        j({ type: "user", message: { role: "user", content: "the login test is flaky" } }),
        j({ type: "assistant", message: { role: "assistant", model: "claude-x", content: [{ type: "thinking", thinking: "hm" }, { type: "tool_use", id: "t1", name: "Read", input: { file_path: "login.test.ts" } }] } }),
        j({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "it('logs in', …)" }] } }),
        j({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "It races the timer." }] } }),
        j({ type: "user", message: { role: "user", content: "<local-command-stdout>ok</local-command-stdout>" } }),
        "not json",
      ],
      "/w",
    );
    expect(doc).toMatchObject({ title: "Fix the flaky test", source: "claude-code", model: "claude-x" });
    expect(doc.messages).toEqual([
      { role: "user", text: "the login test is flaky" },
      { role: "assistant", text: "It races the timer.", tools: [{ name: "Read", target: "login.test.ts", result: "it('logs in', …)" }] },
    ]);
  });

  it("Claude Code's folder names", () => {
    expect(claudeProjectDirName("/Users/me/Documents/Github/AI")).toBe("-Users-me-Documents-Github-AI");
    expect(claudeProjectDirName("/a/b.c_d")).toBe("-a-b-c-d");
  });

  it("Codex: the user's own messages (not injected context), replies, calls and outputs", () => {
    const doc = parseCodex([
      j({ type: "session_meta", payload: { cwd: "/w" } }),
      j({ type: "turn_context", payload: { model: "gpt-5.5" } }),
      j({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "<environment_context>…" }] } }),
      j({ type: "event_msg", payload: { type: "user_message", message: "run the tests" } }),
      j({ type: "response_item", payload: { type: "function_call", name: "shell", arguments: j({ command: ["npm", "test"] }), call_id: "c1" } }),
      j({ type: "response_item", payload: { type: "function_call_output", call_id: "c1", output: "2 passing" } }),
      j({ type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "All green." }] } }),
    ]);
    expect(doc.cwd).toBe("/w");
    expect(doc.model).toBe("gpt-5.5");
    expect(doc.title).toBe("run the tests");
    expect(doc.messages).toEqual([
      { role: "user", text: "run the tests" },
      { role: "assistant", text: "All green.", tools: [{ name: "shell", target: "npm test", result: "2 passing" }] },
    ]);
  });

  it("opencode: text and tool parts; synthetic context skipped", () => {
    const doc = parseOpencode({
      session: { id: "s", title: "Add a route", directory: "/w", model: null },
      messages: [
        { id: "m1", data: j({ role: "user" }) },
        { id: "m2", data: j({ role: "assistant" }) },
      ],
      parts: [
        { message_id: "m1", data: j({ type: "text", text: "<system-reminder>opened a file</system-reminder>", synthetic: true }) },
        { message_id: "m1", data: j({ type: "text", text: "add a /health route" }) },
        { message_id: "m2", data: j({ type: "step-start" }) },
        { message_id: "m2", data: j({ type: "tool", tool: "edit", state: { status: "completed", input: { filePath: "app.ts" }, output: "ok" } }) },
        { message_id: "m2", data: j({ type: "text", text: "Added." }) },
      ],
    });
    expect(doc).toMatchObject({ title: "Add a route", source: "opencode" });
    expect(doc.messages).toEqual([
      { role: "user", text: "add a /health route" },
      { role: "assistant", text: "Added.", tools: [{ name: "edit", target: "app.ts", result: "ok" }] },
    ]);
  });
});
