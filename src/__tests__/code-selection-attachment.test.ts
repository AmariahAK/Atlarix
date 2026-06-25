/**
 * C2 — code-selection chip: the display label is `basename:lineStart-lineEnd`,
 * while the model gets the full workspace-relative path + range + content.
 */
import { describe, expect, it } from "vitest";
import {
  isCodeSelectionAttachment,
  codeSelectionDisplayName,
  buildCodeSelectionModelBlock,
  buildCodeSelectionDisplayBlock,
  type CodeSelectionAttachment,
} from "@/lib/chat/code-selection-attachment";
import { buildPastePromptsFromAttachments } from "@/lib/chat/attachment-tag-blocks";

const att: CodeSelectionAttachment = {
  type: "chat-context",
  codeSelection: {
    relpath: "src/models/user.py",
    lineStart: 110,
    lineEnd: 137,
    content: "def get_user(id):\n    return db.find(id)",
  },
};

describe("code-selection-attachment (C2)", () => {
  it("type guard recognizes a code-selection attachment", () => {
    expect(isCodeSelectionAttachment(att)).toBe(true);
    expect(isCodeSelectionAttachment({ type: "chat-context" })).toBe(false);
  });

  it("display name is basename:range (never the full path)", () => {
    expect(codeSelectionDisplayName("src/models/user.py", 110, 137)).toBe(
      "user.py:110-137",
    );
    // single-line selection
    expect(codeSelectionDisplayName("a/b/c.ts", 42, 42)).toBe("c.ts:42");
  });

  it("model block carries the FULL path + range + content; display block is a stub", () => {
    const model = buildCodeSelectionModelBlock(att);
    expect(model).toContain('path="src/models/user.py"');
    expect(model).toContain('lines="110-137"');
    expect(model).toContain("def get_user(id):");

    const display = buildCodeSelectionDisplayBlock(att);
    expect(display).toContain('path="user.py"'); // basename only for display
    expect(display).toContain('lines="110-137"');
    expect(display).not.toContain("def get_user"); // no body in display
  });

  it("buildPastePromptsFromAttachments injects model block, keeps display clean", () => {
    const { modelPrompt, displayPrompt } = buildPastePromptsFromAttachments(
      "Explain this function",
      [att],
    );
    expect(modelPrompt).toContain("Explain this function");
    expect(modelPrompt).toContain("<atlarix-code-selection");
    expect(modelPrompt).toContain("src/models/user.py");
    expect(modelPrompt).toContain("return db.find(id)");

    expect(displayPrompt).toContain("Explain this function");
    expect(displayPrompt).toContain("user.py");
    expect(displayPrompt).not.toContain("return db.find(id)"); // body not shown
  });
});
