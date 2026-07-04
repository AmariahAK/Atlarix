import type { FileAttachment, PasteAttachmentMeta } from "@/ipc/ipc_types";
import { ensurePasteAttachmentIds } from "@/lib/attachment-persistence";
import { findAttachmentTagsInContent } from "@/lib/chat/attachment-tag-parse";
import { isTerminalPasteAttachment } from "@/lib/chat/terminal-paste-attachment";
import { isTextPasteAttachment } from "@/lib/chat/text-paste-attachment";

export function collectPasteAttachmentsFromFileAttachments(
  attachments: FileAttachment[] | undefined,
): PasteAttachmentMeta[] {
  if (!attachments?.length) return [];
  const out: PasteAttachmentMeta[] = [];
  for (const att of attachments) {
    if (isTextPasteAttachment(att)) {
      out.push({
        kind: "text",
        displayName: att.textPaste.displayName,
        content: att.textPaste.content,
      });
    } else if (isTerminalPasteAttachment(att)) {
      const tp = att.terminalPaste;
      out.push({
        kind: "terminal",
        displayName: tp.displayName,
        content: tp.content,
        displayContent: tp.displayContent ?? tp.content,
      });
    }
  }
  return ensurePasteAttachmentIds(out);
}

/** Recover paste bodies from model-facing XML when only stub tags were stored in `content`. */
export function extractPasteAttachmentsFromModelContent(
  modelContent: string | null | undefined,
): PasteAttachmentMeta[] {
  if (!modelContent?.trim()) return [];
  const out: PasteAttachmentMeta[] = [];
  for (const tag of findAttachmentTagsInContent(modelContent)) {
    const body = tag.content.trim();
    if (!body) continue;
    if (tag.tag === "atlarix-text-attachment") {
      out.push({
        kind: "text",
        displayName: tag.attributes.filename || "Pasted text",
        content: body,
      });
    } else if (tag.tag === "atlarix-terminal-attachment") {
      const label = tag.attributes.label || "Terminal output";
      out.push({
        kind: "terminal",
        displayName: label,
        content: body,
        displayContent:
          tag.attributes.displayContent?.replace(/\\n/g, "\n") ?? body,
      });
    }
  }
  return ensurePasteAttachmentIds(out);
}

export function resolvePasteAttachmentsForMessage(message: {
  pasteAttachments?: PasteAttachmentMeta[] | null;
  modelContent?: string | null;
}): PasteAttachmentMeta[] {
  if (message.pasteAttachments?.length) {
    return ensurePasteAttachmentIds(message.pasteAttachments);
  }
  return extractPasteAttachmentsFromModelContent(message.modelContent);
}

/**
 * W2 (v14.8.11): rebuild MODEL-facing content from display content by
 * expanding self-closing attachment stubs to their full-bodied blocks using
 * the message's stored paste metas. Used when a user EDITS a sent message —
 * the row's old modelContent is stale (pre-edit prose) and must be
 * regenerated, not kept or dropped. Stubs with no matching paste, and
 * already-full paired tags, pass through unchanged.
 */
export function expandAttachmentStubsToModelContent(
  displayContent: string,
  pasteAttachments: PasteAttachmentMeta[],
): string {
  if (!displayContent || pasteAttachments.length === 0) return displayContent;
  const tags = findAttachmentTagsInContent(displayContent);
  if (tags.length === 0) return displayContent;
  let out = "";
  let cursor = 0;
  for (const tag of tags) {
    out += displayContent.slice(cursor, tag.startIndex);
    cursor = tag.startIndex + tag.fullMatch.length;
    const isStub = tag.content.trim().length === 0;
    if (!isStub) {
      out += tag.fullMatch;
      continue;
    }
    if (tag.tag === "atlarix-text-attachment") {
      const body = lookupTextPasteContent(
        tag.attributes.filename || "Pasted text",
        pasteAttachments,
      );
      out += body
        ? tag.fullMatch.replace(/\s*\/>\s*$/, ">") +
          `\n${body}\n</atlarix-text-attachment>`
        : tag.fullMatch;
    } else {
      const { content: body } = lookupTerminalPasteContent(
        tag.attributes.label || "Terminal output",
        pasteAttachments,
      );
      out += body
        ? tag.fullMatch.replace(/\s*\/>\s*$/, ">") +
          `\n${body}\n</atlarix-terminal-attachment>`
        : tag.fullMatch;
    }
  }
  out += displayContent.slice(cursor);
  return out;
}

export function lookupTextPasteContent(
  displayName: string,
  pasteAttachments: PasteAttachmentMeta[],
): string {
  const match = pasteAttachments.find(
    (p) => p.kind === "text" && p.displayName === displayName,
  );
  return match?.content ?? "";
}

export function lookupTerminalPasteContent(
  label: string,
  pasteAttachments: PasteAttachmentMeta[],
): { content: string; displayContent?: string } {
  const match = pasteAttachments.find(
    (p) => p.kind === "terminal" && p.displayName === label,
  );
  if (!match) return { content: "" };
  return {
    content: match.content,
    displayContent: match.displayContent ?? match.content,
  };
}
