/**
 * QA (app) #3: inline code in chat answers showed literal backticks
 * (`npm test`). Tailwind Typography adds them as code::before/::after content;
 * the chat's prose classes now clear both.
 */
import { describe, it, expect } from "vitest";
import { CHAT_MESSAGE_MARKDOWN_PROSE } from "@/components/chat/AtlarixMarkdownParser";

describe("inline code in a chat answer", () => {
  it("has no backticks drawn around it", () => {
    const classes = CHAT_MESSAGE_MARKDOWN_PROSE.split(/\s+/);
    expect(classes).toContain("prose-code:before:content-none");
    expect(classes).toContain("prose-code:after:content-none");
  });
});
