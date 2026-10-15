/**
 * A whole-file write that replaced a file's text shows what it replaced: the
 * finished card read "+1 −0" (only "+ rc smoke ok") while the approval and the
 * tool result said +1 −1 (QA 15.7.1, CLI and VS Code). The write's previous
 * text is kept for display, never sent to the model.
 */
import { describe, expect, it } from "vitest";
import { editDiff, toolLine } from "@/cli/agent/transcript";
import { snippetDiff } from "@/cli/acp/updates";
import { rememberWritePrevious } from "@/lib/chat/write-previous";

const write = { path: "a.txt", operation: "write", content: "rc smoke ok" };

describe("a whole-file write over an existing file", () => {
  it("counts the old text as removed", () => {
    rememberWritePrevious("call_w1", "ALPHA\n");
    const line = toolLine({
      type: "tool",
      id: "edit_file-0",
      callId: "call_w1",
      toolName: "edit_file",
      status: "success",
      args: write,
      resultText: '{"success":true,"operation":"write","added":1,"removed":1}',
    });
    expect(line.diff).toMatchObject({ added: 1, removed: 1 });
    expect(line.summary).toBe("+1 −1");
    expect(snippetDiff("a.txt", line.diff!)).toMatchObject({ oldText: "ALPHA", newText: "rc smoke ok" });
  });

  it("is all additions for a new file, as before", () => {
    expect(editDiff(write)).toMatchObject({ added: 1, removed: 0 });
  });
});
