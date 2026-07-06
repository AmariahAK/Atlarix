import type { FileAttachment } from "@/ipc/ipc_types";
import {
  commandToolLabel,
  linesToVisibleText,
  type FormattableLine,
} from "@/lib/chat/terminal-line-format";
import { escapeAttachmentTagBody } from "@/lib/chat/attachment-tag-escape";

function escapeXmlAttr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;");
}

export type TerminalPasteOwner = "user" | "agent";

export interface TerminalPastePayload {
  content: string;
  displayName: string;
  instanceLabel: string;
  owner: TerminalPasteOwner;
  lineStart: number;
  lineEnd: number;
}

export function isTerminalPasteAttachment(
  attachment: FileAttachment,
): attachment is FileAttachment & { terminalPaste: TerminalPastePayload } {
  return Boolean(attachment.terminalPaste?.content);
}

export function terminalShortLabel(
  owner: TerminalPasteOwner,
  instanceLabel: string,
): string {
  if (owner === "agent") {
    const m = instanceLabel.match(/Agent\s+(\d+)/i);
    return m ? `A${m[1]}` : "A";
  }
  return "zsh";
}

export function terminalPasteDisplayName(
  owner: TerminalPasteOwner,
  instanceLabel: string,
  lineStart: number,
  lineEnd: number,
  commandHint?: string,
  fallbackShell = "zsh",
): string {
  const short =
    commandHint != null && commandHint.length > 0
      ? commandToolLabel(commandHint, fallbackShell)
      : terminalShortLabel(owner, instanceLabel);
  if (lineStart === lineEnd) {
    return `${short} (${lineStart})`;
  }
  return `${short} (${lineStart}-${lineEnd})`;
}

/** Map a text selection to 1-based line numbers within visible terminal log lines. */
export function terminalSelectionLineRange(
  lines: FormattableLine[],
  selectedText: string,
  fullTextOverride?: string,
): { start: number; end: number } {
  const fullText = fullTextOverride ?? linesToVisibleText(lines);
  const trimmed = selectedText.trim();
  if (!trimmed) {
    return { start: 1, end: 1 };
  }
  const idx = fullText.indexOf(trimmed);
  if (idx < 0) {
    const selLines = (trimmed.match(/\n/g) || []).length + 1;
    return { start: 1, end: selLines };
  }
  const before = fullText.slice(0, idx);
  const start = (before.match(/\n/g) || []).length + 1;
  const end = start + (trimmed.match(/\n/g) || []).length;
  return { start, end };
}

export function buildTerminalPasteBlocks(
  attachments: FileAttachment[] | undefined,
): string[] {
  if (!attachments?.length) return [];
  const blocks: string[] = [];
  for (const att of attachments) {
    if (!isTerminalPasteAttachment(att)) continue;
    const { displayName, content, lineStart, lineEnd, owner } =
      att.terminalPaste;
    blocks.push(
      `<atlarix-terminal-attachment label="${escapeXmlAttr(displayName)}" owner="${escapeXmlAttr(owner)}" lines="${lineStart}-${lineEnd}">\n${escapeAttachmentTagBody(content)}\n</atlarix-terminal-attachment>`,
    );
  }
  return blocks;
}

/** UI/storage: chip label only (multiline content cannot live safely in XML attributes). */
export function buildTerminalPasteDisplayBlocks(
  attachments: FileAttachment[] | undefined,
): string[] {
  if (!attachments?.length) return [];
  const blocks: string[] = [];
  for (const att of attachments) {
    if (!isTerminalPasteAttachment(att)) continue;
    const { displayName, lineStart, lineEnd, owner } = att.terminalPaste;
    blocks.push(
      `<atlarix-terminal-attachment label="${escapeXmlAttr(displayName)}" owner="${escapeXmlAttr(owner)}" lines="${lineStart}-${lineEnd}" />`,
    );
  }
  return blocks;
}
