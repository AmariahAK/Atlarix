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

  it("strips unclosed thinking tags from visible answer while streaming", () => {
    const content =
      "<think>Still planning the approach without a close tag yet";
    const visible = extractVisibleAnswerMarkdown(content);
    expect(visible).toBe("");
  });

  it("does not duplicate in-progress thinking into visible answer", () => {
    const content =
      "<think>The user wants an E2E flow explanation.</think>\n\nFinal answer here.";
    const visible = extractVisibleAnswerMarkdown(content);
    expect(visible).not.toContain("E2E flow explanation");
    expect(visible).toContain("Final answer here");
  });

  it("preserves plan artifact markers", () => {
    const marker =
      "<!-- atlarix-plan-artifact:787bb61d-51c9-4476-9370-ee0d7a6a7832 -->";
    const visible = extractVisibleAnswerMarkdown(`${marker}\nShort intro.`);
    expect(visible).toContain("atlarix-plan-artifact");
    expect(visible).toContain("Short intro");
  });
});
