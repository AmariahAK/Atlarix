import { describe, expect, it } from "vitest";
import { finalAnswerText } from "@/lib/chat/assistant-message-parts";

describe("finalAnswerText", () => {
  it("is the prose after the last tool call, without the tool envelopes", () => {
    // The shape a real headless run stored (scripts' local action run, 2026-10-03).
    const raw = [
      "Let me look.",
      '<atlarix-tool-call tool="read_file" call="c1" status="running">\n{"path":"sum.js"}\n</atlarix-tool-call>',
      '<atlarix-tool-result tool="read_file" call="c1" status="complete">\n{"success":true,"result":"File: sum.js"}\n</atlarix-tool-result>',
      '<atlarix-tool-call tool="run_command" call="c2" status="running">\n{"command":"node test.js"}\n</atlarix-tool-call>',
      '<atlarix-tool-result tool="run_command" call="c2" status="complete">\n{"success":true,"output":"ok","exitCode":0}\n</atlarix-tool-result>',
      "Fixed. The loop started at `i = 1`; it starts at `i = 0` now.",
    ].join("\n");
    const out = finalAnswerText(raw);
    expect(out).toBe("Fixed. The loop started at `i = 1`; it starts at `i = 0` now.");
    expect(out).not.toContain("atlarix-tool");
  });

  it("with no tool calls, all the prose", () => {
    expect(finalAnswerText("Just an answer.")).toBe("Just an answer.");
  });
});
