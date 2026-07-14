import { describe, expect, it } from "vitest";
import { findAttachmentTagsInContent } from "@/lib/chat/attachment-tag-parse";
import { buildPromptWithTextPastes } from "@/lib/chat/text-paste-attachment";

describe("attachment-tag-parse", () => {
  it("parses large text attachment bodies without regex failure", () => {
    const body = Array.from({ length: 400 }, (_, i) => `line ${i}`).join("\n");
    const content = `hello\n\n<atlarix-text-attachment filename="Pasted text · 400 lines">\n${body}\n</atlarix-text-attachment>`;
    const tags = findAttachmentTagsInContent(content);
    expect(tags).toHaveLength(1);
    expect(tags[0]?.content).toContain("line 399");
    expect(tags[0]?.attributes.filename).toContain("400");
  });

  it("parses self-closing display stub tags", () => {
    const content =
      'Question\n\n<atlarix-text-attachment filename="Pasted text · 2 lines" />';
    const tags = findAttachmentTagsInContent(content);
    expect(tags).toHaveLength(1);
    expect(tags[0]?.content).toBe("");
  });

  it("parses a self-closing background-job display stub (renders as a chip, not raw text)", () => {
    const content =
      'does that mean we can stop this?\n\n<atlarix-background-job job_id="op_1783968408218_2j0czw7yb" />';
    const tags = findAttachmentTagsInContent(content);
    expect(tags).toHaveLength(1);
    expect(tags[0]?.tag).toBe("atlarix-background-job");
    expect(tags[0]?.attributes.job_id).toBe("op_1783968408218_2j0czw7yb");
    expect(tags[0]?.content).toBe("");
  });

  it("parses a background-job model block with command + output tail", () => {
    const content =
      '<atlarix-background-job job_id="op_1" command="npm test">\n42 passing\n</atlarix-background-job>';
    const tags = findAttachmentTagsInContent(content);
    expect(tags).toHaveLength(1);
    expect(tags[0]?.attributes.command).toBe("npm test");
    expect(tags[0]?.content).toContain("42 passing");
  });

  it("parses terminal self-closing tag without displayContent attribute", () => {
    const content =
      'Hi\n\n<atlarix-terminal-attachment label="ls (1-16)" owner="user" lines="1-16" />';
    const tags = findAttachmentTagsInContent(content);
    expect(tags).toHaveLength(1);
    expect(tags[0]?.attributes.label).toBe("ls (1-16)");
    expect(tags[0]?.attributes.displayContent).toBeUndefined();
  });

  it("buildPromptWithTextPastes splits display and model prompts", () => {
    const long = "x".repeat(600);
    const { modelPrompt, displayPrompt } = buildPromptWithTextPastes("Hi", [
      {
        type: "chat-context",
        textPaste: { content: long, displayName: "Pasted text · 1 line" },
      },
    ]);
    expect(modelPrompt).toContain(long);
    expect(displayPrompt).not.toContain(long);
    expect(displayPrompt).toContain("<atlarix-text-attachment");
    expect(displayPrompt).toContain("/>");
  });
});
