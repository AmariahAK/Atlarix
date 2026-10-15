/**
 * Atlarix Auto fills every field of edit_file's schema: a `replace` came with
 * `content: ""` beside `old_content` / `new_content` / `edits`. The card took
 * `content` first because "" is a string, so the expanded diff showed the old
 * file all removed and nothing added, under a "+1" header (Windows VM QA,
 * 2026-10-14; the merged whole file on the card was right).
 */
import { describe, it, expect } from "vitest";
import { buildToolExpandView } from "@/lib/chat/tool-expand-view";
import {
  DISPLAY_PREVIEW_ARG,
  enrichStreamThreadFromAssistantContent,
  type StreamThreadItem,
} from "@/lib/chat/stream-thread";

const OLD = "line one\nline two\n";
const NEW = "line one\nline two\nline three\n";
const modelArgs = {
  path: "a.txt",
  operation: "replace",
  content: "",
  old_content: "line two",
  new_content: "line two\nline three",
  edits: [{ old_content: "line two", new_content: "line two\nline three" }],
};
const result = JSON.stringify({ success: true, message: "Successfully wrote a.txt", path: "a.txt", added: 1, removed: 0 });

describe("an edit card when the model sends an empty `content`", () => {
  it("shows the edit, not the old text removed", () => {
    const view = buildToolExpandView("edit_file", modelArgs, result, "done");
    expect(view?.kind).toBe("diff");
    const d = view as Extract<typeof view, { kind: "diff" }>;
    expect(d.newContent).toContain("line three");
  });

  it("keeps the merged whole file when the reply's own tool tags are folded in", () => {
    const merged = { ...modelArgs, [DISPLAY_PREVIEW_ARG]: true, old_content: OLD, content: NEW };
    const item: StreamThreadItem = {
      kind: "tool",
      id: "call_1",
      toolName: "edit_file",
      summary: "Edited a.txt",
      toolArgs: merged,
      resultText: result,
      status: "done",
      ts: 1,
    };
    const content =
      `<atlarix-tool-call tool="edit_file" call="call_1" status="complete">\n${JSON.stringify(modelArgs)}\n</atlarix-tool-call>\n` +
      `<atlarix-tool-result tool="edit_file" call="call_1" status="complete">\n${result}\n</atlarix-tool-result>`;
    const [out] = enrichStreamThreadFromAssistantContent([item], content);
    const view = (out as Extract<StreamThreadItem, { kind: "tool" }>).expand as { kind: string; oldContent: string; newContent: string };
    expect(view?.kind).toBe("diff");
    expect(view.oldContent).toBe(OLD);
    expect(view.newContent).toBe(NEW);
  });
});
