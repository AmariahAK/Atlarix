import { describe, expect, it } from "vitest";
import {
  buildPasteAttachmentDirective,
  ensurePasteAttachmentIds,
  hydrateAttachmentStoreFromMessages,
  pasteToAttachmentData,
  resolvePasteAttachmentId,
} from "@/lib/attachment-persistence";
import { AttachmentStore } from "@/lib/attachment-store";

describe("attachment-persistence", () => {
  it("assigns stable ids to paste attachments", () => {
    const pastes = ensurePasteAttachmentIds([
      {
        kind: "text",
        displayName: "Pasted text · 2 lines",
        content: "hello\nworld",
      },
    ]);
    expect(pastes[0]?.id).toBeTruthy();
    expect(resolvePasteAttachmentId(pastes[0]!)).toBe(pastes[0]!.id);
  });

  it("resolvePasteAttachmentId is deterministic for legacy rows", () => {
    const paste = {
      kind: "text" as const,
      displayName: "notes",
      content: "hello",
    };
    expect(resolvePasteAttachmentId(paste)).toBe(resolvePasteAttachmentId(paste));
    expect(resolvePasteAttachmentId(paste)).toMatch(/^paste-[0-9a-f]{16}$/);
  });

  it("registers paste attachments for read_attachment", () => {
    AttachmentStore.clear();
    const paste = ensurePasteAttachmentIds([
      {
        kind: "terminal",
        displayName: "ls (1-16)",
        content: "[You] $ ls\nscripts",
        displayContent: "[You] $ ls\nscripts",
      },
    ])[0]!;
    const record = pasteToAttachmentData(paste);
    AttachmentStore.add(record);
    expect(AttachmentStore.get(record.id)?.filename).toContain("ls");
  });

  it("hydrates file and paste attachments from message records", () => {
    AttachmentStore.clear();
    hydrateAttachmentStoreFromMessages([
      {
        fileAttachments: [
          {
            id: "file-1",
            filename: "Resume.pdf",
            mimeType: "application/pdf",
            size: 4,
            data: Buffer.from("pdf").toString("base64"),
          },
        ],
        pasteAttachments: [
          {
            id: "paste-1",
            kind: "text",
            displayName: "notes",
            content: "line",
          },
        ],
      },
    ]);
    expect(AttachmentStore.get("file-1")?.filename).toBe("Resume.pdf");
    expect(AttachmentStore.get("paste-1")?.mimeType).toBe("text/plain");
  });

  it("builds paste directive with attachment ids", () => {
    const directive = buildPasteAttachmentDirective([
      {
        id: "paste-abc",
        kind: "text",
        displayName: "Pasted text · 791 lines",
        content: "x",
      },
    ]);
    expect(directive).toContain("paste-abc");
    expect(directive).toContain("PASTED CONTENT ATTACHED");
  });
});
