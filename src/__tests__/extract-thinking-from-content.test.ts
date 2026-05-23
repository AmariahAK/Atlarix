import { describe, expect, it } from "vitest";
import { extractThinkingFromContent } from "@/lib/thinking/extract-thinking-from-content";
import { stripAssistantDisplayContent } from "@/ipc/utils/thinking_tags";

describe("extractThinkingFromContent", () => {
  it("retains redacted_thinking after stripAssistantDisplayContent removes it from DB text", () => {
    const open = "<think>";
    const close = "</think>";
    const live = `Hello${open}Plan the API change${close} Here is the answer.`;
    const stored = stripAssistantDisplayContent(live);
    expect(stored).not.toContain("Plan the API");

    const snap = extractThinkingFromContent(live);
    expect(snap.modelReasoning).toContain("Plan the API change");
  });

  it("extracts tool call tags", () => {
    const content =
      '<atlarix-tool-call tool="read_file" status="success">{"path":"a.ts"}</atlarix-tool-call>';
    const snap = extractThinkingFromContent(content);
    expect(snap.toolCalls).toHaveLength(1);
    expect(snap.toolCalls[0].toolName).toBe("read_file");
  });
});
