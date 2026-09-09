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
    expect(resolvePasteAttachmentId(paste)).toBe(
      resolvePasteAttachmentId(paste),
    );
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

// ── W2 (v14.8.11): ids are DETERMINISTIC (content-hash), never random —
// the old randomUUID branch minted fresh ids on rehydration, so a re-read
// after an interrupted turn returned "Attachment not found". ──
describe("deterministic ids across rehydration (W2)", () => {
  const paste = {
    kind: "text" as const,
    displayName: "Pasted text · 34 lines",
    content: "line one\nline two\nline three",
  };

  it("same content always yields the same id (no randomUUID)", () => {
    const [a] = ensurePasteAttachmentIds([{ ...paste }]);
    const [b] = ensurePasteAttachmentIds([{ ...paste }]);
    expect(a!.id).toBeTruthy();
    expect(a!.id).toBe(b!.id);
    expect(a!.id).toBe(resolvePasteAttachmentId(paste));
    expect(a!.id).not.toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-/); // not a UUID
  });

  it("re-read by the ORIGINAL id succeeds after rehydration from modelContent", async () => {
    const { extractPasteAttachmentsFromModelContent } = await import(
      "@/lib/chat/paste-attachment-meta"
    );
    AttachmentStore.clear();
    // 1. Send time: deterministic id announced to the model + stored.
    const [sent] = ensurePasteAttachmentIds([{ ...paste }]);
    AttachmentStore.add(pasteToAttachmentData(sent!));
    const announcedId = sent!.id!;
    expect(AttachmentStore.get(announcedId)).toBeTruthy();

    // 2. Interruption: only modelContent survives (no pasteAttachments JSON).
    const modelContent = `check this\n\n<atlarix-text-attachment filename="${sent!.displayName}">\n${sent!.content}\n</atlarix-text-attachment>`;

    // 3. Rehydration derives the SAME id from the same content.
    const recovered = extractPasteAttachmentsFromModelContent(modelContent);
    expect(recovered).toHaveLength(1);
    expect(recovered[0]!.id).toBe(announcedId);

    AttachmentStore.clear();
    hydrateAttachmentStoreFromMessages([{ pasteAttachments: recovered }]);
    expect(AttachmentStore.get(announcedId)).toBeTruthy();
  });
});

describe("expandAttachmentStubsToModelContent — edited-message model rebuild (W2)", () => {
  it("expands text and terminal stubs to full-bodied blocks", async () => {
    const { expandAttachmentStubsToModelContent } = await import(
      "@/lib/chat/paste-attachment-meta"
    );
    const pastes = ensurePasteAttachmentIds([
      {
        kind: "text",
        displayName: "Pasted text · 34 lines",
        content: "line one\nline two",
      },
      {
        kind: "terminal",
        displayName: "Terminal output",
        content: "$ npm test\nall green",
      },
    ]);
    const display =
      'edited prose\n\n<atlarix-text-attachment filename="Pasted text · 34 lines" />\n\n<atlarix-terminal-attachment label="Terminal output" owner="user" lines="1-2" />';
    const out = expandAttachmentStubsToModelContent(display, pastes);
    expect(out).toContain("edited prose");
    expect(out).toContain("line one\nline two");
    expect(out).toContain("$ npm test\nall green");
    expect(out).not.toMatch(/<atlarix-text-attachment[^>]*\/>/);
    expect(out).toContain("</atlarix-text-attachment>");
    expect(out).toContain("</atlarix-terminal-attachment>");
  });

  it("leaves unmatched stubs and already-full tags untouched", async () => {
    const { expandAttachmentStubsToModelContent } = await import(
      "@/lib/chat/paste-attachment-meta"
    );
    const pastes = ensurePasteAttachmentIds([
      { kind: "text" as const, displayName: "Known", content: "body" },
    ]);
    const display =
      '<atlarix-text-attachment filename="Unknown paste" />\n<atlarix-text-attachment filename="X">\nalready full\n</atlarix-text-attachment>';
    const out = expandAttachmentStubsToModelContent(display, pastes);
    expect(out).toContain(
      '<atlarix-text-attachment filename="Unknown paste" />',
    );
    expect(out).toContain("already full");
  });

  it("no tags → content unchanged", async () => {
    const { expandAttachmentStubsToModelContent } = await import(
      "@/lib/chat/paste-attachment-meta"
    );
    expect(expandAttachmentStubsToModelContent("plain text", [])).toBe(
      "plain text",
    );
  });
});
