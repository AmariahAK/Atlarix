import type { FileAttachment } from "@/ipc/ipc_types";
import { escapeXmlAttr } from "@/lib/chat/attachment-tag-blocks";

/**
 * C2 — code-selection attachments. Selecting text in the Code tab and sending it
 * to chat creates a removable chip (like pasted-text / @-mention chips). The chip
 * shows the basename + line range (`user.py:110-137`); on send the model gets the
 * full workspace-relative path, the line range, and the content.
 */
export type CodeSelectionAttachment = FileAttachment & {
  codeSelection: NonNullable<FileAttachment["codeSelection"]>;
};

export function isCodeSelectionAttachment(
  attachment: FileAttachment,
): attachment is CodeSelectionAttachment {
  return Boolean(attachment.codeSelection?.relpath);
}

function basename(relpath: string): string {
  const segs = relpath.split(/[/\\]+/).filter(Boolean);
  return segs.length > 0 ? segs[segs.length - 1] : relpath;
}

/** Human chip label: `user.py:110-137` (basename, never the full path). */
export function codeSelectionDisplayName(
  relpath: string,
  lineStart: number,
  lineEnd: number,
): string {
  const range = lineStart === lineEnd ? `${lineStart}` : `${lineStart}-${lineEnd}`;
  return `${basename(relpath)}:${range}`;
}

/** Model-facing block: full path + line range + content. */
export function buildCodeSelectionModelBlock(att: CodeSelectionAttachment): string {
  const { relpath, lineStart, lineEnd, content } = att.codeSelection;
  return [
    `<atlarix-code-selection path="${escapeXmlAttr(relpath)}" lines="${lineStart}-${lineEnd}">`,
    content,
    "</atlarix-code-selection>",
  ].join("\n");
}

/** Display-only stub (no body) — the chip already shows what was referenced. */
export function buildCodeSelectionDisplayBlock(att: CodeSelectionAttachment): string {
  const { relpath, lineStart, lineEnd } = att.codeSelection;
  return `<atlarix-code-selection path="${escapeXmlAttr(basename(relpath))}" lines="${lineStart}-${lineEnd}" />`;
}
