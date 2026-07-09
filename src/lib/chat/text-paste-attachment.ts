import type { FileAttachment } from "@/ipc/ipc_types";
import { buildPastePromptsFromAttachments } from "@/lib/chat/attachment-tag-blocks";

export function isTextPasteAttachment(
  attachment: FileAttachment,
): attachment is FileAttachment & { textPaste: { content: string; displayName: string } } {
  return Boolean(attachment.textPaste?.content);
}

/**
 * Read pasted text from the clipboard, resilient to the SOURCE app.
 *
 * Code editors (Cursor/VS Code) populate `text/plain`, but rich-text apps
 * (Notes/TextEdit/word processors) may put the content only in `text/html` and
 * leave `text/plain` empty — which meant a large paste from those apps silently
 * fell through and got dropped inline instead of becoming an attachment. When
 * `text/plain` is empty we fall back to `text/html`, stripped to plain text via
 * the DOM (renderer-only; no dependency).
 */
export function readClipboardPlainText(clipboardData: DataTransfer): string {
  const plain = clipboardData.getData("text/plain");
  if (plain.trim()) return plain;
  const html = clipboardData.getData("text/html");
  if (html.trim() && typeof DOMParser !== "undefined") {
    try {
      const doc = new DOMParser().parseFromString(html, "text/html");
      return doc.body?.textContent ?? "";
    } catch {
      /* fall through to empty */
    }
  }
  return "";
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
): {
  prompt: string;
  modelPrompt: string;
  displayPrompt: string;
  fileAttachments: FileAttachment[];
} {
  const built = buildPastePromptsFromAttachments(prompt, attachments);
  return {
    prompt: built.modelPrompt,
    modelPrompt: built.modelPrompt,
    displayPrompt: built.displayPrompt,
    fileAttachments: built.fileAttachments,
  };
}
