import { describe, expect, it } from "vitest";
import { extractVisibleAnswerMarkdown } from "@/lib/chat/answer-display";

describe("extractVisibleAnswerMarkdown", () => {
  it("keeps trailing markdown after tool tags", () => {
    const content = [
      '<atlarix-tool-call tool="read_file" status="success"></atlarix-tool-call>',
      '<atlarix-tool-result tool="read_file" status="success"></atlarix-tool-result>',
      "",
      "Here is the final summary for the user.",
    ].join("\n");
    const visible = extractVisibleAnswerMarkdown(content);
    expect(visible).toContain("final summary");
  });

  it("preserves plan artifact markers", () => {
    const marker =
      "<!-- atlarix-plan-artifact:787bb61d-51c9-4476-9370-ee0d7a6a7832 -->";
    const visible = extractVisibleAnswerMarkdown(`${marker}\nShort intro.`);
    expect(visible).toContain("atlarix-plan-artifact");
    expect(visible).toContain("Short intro");
  });
});
