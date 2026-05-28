import { describe, expect, it } from "vitest";
import {
  collectPasteAttachmentsFromFileAttachments,
  extractPasteAttachmentsFromModelContent,
  lookupTextPasteContent,
  resolvePasteAttachmentsForMessage,
} from "@/lib/chat/paste-attachment-meta";
import type { FileAttachment } from "@/ipc/ipc_types";

describe("paste-attachment-meta", () => {
  it("collects text paste from composer attachments", () => {
    const attachments: FileAttachment[] = [
      {
        type: "chat-context",
        textPaste: {
          displayName: "resume.txt",
          content: "line one\nline two",
        },
      },
    ];
    const meta = collectPasteAttachmentsFromFileAttachments(attachments);
    expect(meta).toHaveLength(1);
    expect(meta[0]).toMatchObject({
      kind: "text",
      displayName: "resume.txt",
      content: "line one\nline two",
    });
  });

  it("extracts bodies from model_content XML", () => {
    const modelContent = `Hi\n<atlarix-text-attachment filename="resume.txt">\nbody here\n</atlarix-text-attachment>`;
    const meta = extractPasteAttachmentsFromModelContent(modelContent);
    expect(meta[0]?.content).toBe("body here");
  });

  it("lookupTextPasteContent resolves chip preview body", () => {
    const meta = collectPasteAttachmentsFromFileAttachments([
      {
        type: "chat-context",
        textPaste: { displayName: "Pasted text", content: "hello" },
      },
    ]);
    expect(lookupTextPasteContent("Pasted text", meta)).toBe("hello");
  });

  it("resolvePasteAttachmentsForMessage prefers stored pasteAttachments", () => {
    const stored = [
      { kind: "text" as const, displayName: "a", content: "stored" },
    ];
    const resolved = resolvePasteAttachmentsForMessage({
      pasteAttachments: stored,
      modelContent: `<atlarix-text-attachment filename="a">other</atlarix-text-attachment>`,
    });
    expect(resolved[0]?.content).toBe("stored");
  });
});
