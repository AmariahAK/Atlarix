/**
 * JSON the model writes inside its own sentence, or in `inline code`, is what
 * it is saying. It became a "◇ unknown" step with the JSON cut from the reply
 * in the app, CLI and editor (QA, 2026-10-14; also in 15.6.0). JSON standing
 * alone on its own line is still read as an echoed tool result.
 */
import { describe, expect, it } from "vitest";
import { parseAssistantMessageParts } from "@/lib/chat/assistant-message-parts";
import { sanitizeMarkdownForDisplay } from "@/lib/chat/answer-display";

const shape = (raw: string) =>
  parseAssistantMessageParts(raw, false).map((p) =>
    p.type === "tool" ? "tool" : p.type === "markdown" ? p.content : p.type,
  );

describe("JSON in the model's own text", () => {
  it("mid-sentence stays in the reply, with no tool step", () => {
    const s = 'The endpoint returns {"success":true,"message":"saved"} when it works.';
    expect(shape(s)).toEqual([s]);
  });

  it("in inline code stays in the reply, with no tool step", () => {
    const s = 'On a bad key it replies `{"success":false,"error":"bad key"}`, so check the key.';
    expect(shape(s)).toEqual([s]);
    expect(shape(`${s}\n\nStreaming too.`)).toEqual([`${s}\n\nStreaming too.`]);
  });

  it("is kept whole by the display sanitizer (no orphan-tail cut)", () => {
    const s = 'Send {"success":true,"message":"ok","cost":0} back to the caller.';
    expect(sanitizeMarkdownForDisplay(s)).toBe(s);
    const t = 'Write `{"message":"hi"}` to the queue.';
    expect(sanitizeMarkdownForDisplay(t)).toBe(t);
  });

  it("as QA's fake model wrote it, nested results included", () => {
    for (const s of [
      'Here is the payload: {"success":true,"result":{"ok":1}} done',
      'Done. Last result: {"success":true,"result":{"content":[{"type":"text","text":"Echo: hi from QA"}],"isError":false},"_truncatedOutput":false}',
      'Suggested: {"success":true,"result":{"connected":false,"server":"Linear","message":"Not connected: the user said not now."}}',
    ]) {
      expect(shape(s)).toEqual([s]);
    }
  });

  it("standing alone on its own line is still an echoed tool result", () => {
    const parts = shape('Here you go.\n{"success":true,"result":"done"}\nAll set.');
    expect(parts).toEqual(["Here you go.", "tool", "All set."]);
    expect(sanitizeMarkdownForDisplay('Here you go.\n{ "success": true, "result": "done" }\nAll set.')).not.toContain('"success"');
  });

  it("a read_file result with _truncatedOutput on its own line is a tool step, not prose (QA 2026-10-31)", () => {
    // The model echoed a read_file result whole: its `result` is a JSON string
    // whose newlines are literal \n escapes, and it carries the _truncatedOutput
    // marker. It must be read as an echoed tool result, never rendered as prose.
    const s = 'Here you go.\n{"success":true,"result":"1: a\\n38: const visible = true","_truncatedOutput":false}\nAll set.';
    const parts = shape(s);
    expect(parts).toEqual(["Here you go.", "tool", "All set."]);
  });
});
