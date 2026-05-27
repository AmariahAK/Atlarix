import type { FileAttachment } from "@/ipc/ipc_types";

function escapeXmlAttr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;");
}

export function isTextPasteAttachment(
  attachment: FileAttachment,
): attachment is FileAttachment & { textPaste: { content: string; displayName: string } } {
  return Boolean(attachment.textPaste?.content);
}

export function textPasteLineCount(content: string): number {
  if (!content) return 0;
  return (content.match(/\n/g) || []).length + 1;
}

export function textPasteDisplayName(content: string): string {
  const n = textPasteLineCount(content);
  return `Pasted text · ${n} line${n === 1 ? "" : "s"}`;
}

const LONG_PASTE_CHAR_THRESHOLD = 500;
const LONG_PASTE_LINE_THRESHOLD = 20;

export function shouldCaptureAsTextPaste(plainText: string): boolean {
  const trimmed = plainText.trim();
  if (!trimmed) return false;
  const lineCount = textPasteLineCount(trimmed);
  return (
    trimmed.length > LONG_PASTE_CHAR_THRESHOLD ||
    lineCount > LONG_PASTE_LINE_THRESHOLD
  );
}

export function formatPasteByteSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(2)} KB`;
  return `${(kb / 1024).toFixed(2)} MB`;
}

export function formatPasteMetadata(content: string): string {
  const bytes = new TextEncoder().encode(content).length;
  const lines = textPasteLineCount(content);
  return `${formatPasteByteSize(bytes)} · ${lines} line${lines === 1 ? "" : "s"}`;
}

/** Split file attachments from long-paste chips; expand prompt with full paste bodies for the model. */
export function buildPromptWithTextPastes(
  prompt: string,
  attachments: FileAttachment[] | undefined,
): { prompt: string; fileAttachments: FileAttachment[] } {
  if (!attachments?.length) {
    return { prompt: prompt.trim(), fileAttachments: [] };
  }

  const fileAttachments: FileAttachment[] = [];
  const pasteBlocks: string[] = [];
  let body = prompt.trim();

  for (const att of attachments) {
    if (isTextPasteAttachment(att)) {
      const name = att.textPaste.displayName;
      pasteBlocks.push(
        `<atlarix-text-attachment filename="${escapeXmlAttr(name)}">\n${att.textPaste.content}\n</atlarix-text-attachment>`,
      );
    } else if (att.file) {
      fileAttachments.push(att);
    }
  }

  if (pasteBlocks.length > 0) {
    body = [body, ...pasteBlocks].filter(Boolean).join("\n\n");
  }

  return { prompt: body, fileAttachments };
}
