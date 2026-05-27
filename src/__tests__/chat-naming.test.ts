import { describe, expect, it } from "vitest";
import {
  isLowQualityGeneratedTitle,
  looksLikeToolOrStructuredDebrisTitle,
  resolveGeneratedChatTitle,
  stripContentForTitleSource,
} from "@/utils/chat_naming";

describe("chat naming", () => {
  it("rejects meta titles like Based on the conversation", () => {
    expect(isLowQualityGeneratedTitle("Based on the conversation")).toBe(true);
    expect(isLowQualityGeneratedTitle("based on the messages")).toBe(true);
  });

  it("rejects tool-call JSON as a title", () => {
    const bad =
      'json{  action: get_blueprint,  path: spacinsider-cli/blueprint.md}';
    expect(looksLikeToolOrStructuredDebrisTitle(bad)).toBe(true);
    expect(isLowQualityGeneratedTitle(bad)).toBe(true);
  });

  it("falls back to first user message when AI returns tool debris", () => {
    const title = resolveGeneratedChatTitle(
      'json{ action: get_blueprint, path: spacinsider-cli/blueprint.md}',
      [
        {
          role: "user",
          content: "Explain the SpacGPT @ mention flow in spacinsider-cli",
        },
      ],
      "Untitled",
    );
    expect(title.toLowerCase()).toMatch(/spacgpt|mention|spacinsider/);
    expect(title).not.toMatch(/get_blueprint/i);
  });

  it("strips tool tags from assistant content for title context", () => {
    const assistant = [
      "<think>Planning</think>",
      '<atlarix-tool-call tool="explore_folder">{}</atlarix-tool-call>',
      '<atlarix-tool-result tool="explore_folder">ok</atlarix-tool-result>',
      "Here is the E2E flow for @SpacGPT.",
    ].join("\n");
    const stripped = stripContentForTitleSource(assistant, "assistant");
    expect(stripped).toContain("E2E flow");
    expect(stripped).not.toMatch(/atlarix-tool/);
  });

  it("falls back to first user message keywords", () => {
    const title = resolveGeneratedChatTitle(
      "Based on the conversation",
      [{ role: "user", content: "Help me add dark mode to settings" }],
      "New chat",
    );
    expect(title.toLowerCase()).toContain("dark");
    expect(title).not.toMatch(/based on/i);
  });
});
