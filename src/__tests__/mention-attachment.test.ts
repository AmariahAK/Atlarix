import { describe, expect, it } from "vitest";
import type { FileAttachment } from "@/ipc/ipc_types";
import { buildPastePromptsFromAttachments } from "@/lib/chat/attachment-tag-blocks";
import {
  isMentionAttachment,
  mentionToken,
} from "@/lib/chat/mention-attachment";

function mention(kind: "file" | "dir", relpath: string): FileAttachment {
  return {
    type: "chat-context",
    id: `${kind}:${relpath}`,
    mention: { kind, relpath, displayName: kind === "dir" ? `${relpath}/` : relpath },
  };
}

describe("mention attachments", () => {
  it("re-emits @file:/@dir: tokens into BOTH model and display prompts", () => {
    const { modelPrompt, displayPrompt, fileAttachments } =
      buildPastePromptsFromAttachments("explain auth", [
        mention("file", "src/auth/login.ts"),
        mention("dir", "src/api"),
      ]);

    expect(modelPrompt).toContain("@file:src/auth/login.ts");
    expect(modelPrompt).toContain("@dir:src/api");
    // Display prompt keeps the reference visible too.
    expect(displayPrompt).toContain("@file:src/auth/login.ts");
    // Mentions are NOT file uploads — never base64-encoded.
    expect(fileAttachments).toHaveLength(0);
  });

  it("isMentionAttachment + mentionToken match the dispatch format", () => {
    const fileAtt = mention("file", "a/b.ts");
    const dirAtt = mention("dir", "a/b");
    expect(isMentionAttachment(fileAtt)).toBe(true);
    expect(isMentionAttachment({ type: "chat-context" })).toBe(false);
    expect(mentionToken(fileAtt as never)).toBe("@file:a/b.ts");
    expect(mentionToken(dirAtt as never)).toBe("@dir:a/b");
  });
});
