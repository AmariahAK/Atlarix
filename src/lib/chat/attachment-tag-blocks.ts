import type { FileAttachment } from "@/ipc/ipc_types";
import {
  buildTerminalPasteBlocks,
  buildTerminalPasteDisplayBlocks,
  isTerminalPasteAttachment,
} from "@/lib/chat/terminal-paste-attachment";
import {
  isTextPasteAttachment,
} from "@/lib/chat/text-paste-attachment";

export function escapeXmlAttr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;");
}

function buildTextPasteModelBlock(name: string, body: string): string {
  return `<atlarix-text-attachment filename="${escapeXmlAttr(name)}">\n${body}\n</atlarix-text-attachment>`;
}

function buildTextPasteDisplayBlock(name: string): string {
  return `<atlarix-text-attachment filename="${escapeXmlAttr(name)}" />`;
}

export function buildPastePromptsFromAttachments(
  prompt: string,
  attachments: FileAttachment[] | undefined,
): {
  modelPrompt: string;
  displayPrompt: string;
  fileAttachments: FileAttachment[];
} {
  if (!attachments?.length) {
    const trimmed = prompt.trim();
    return { modelPrompt: trimmed, displayPrompt: trimmed, fileAttachments: [] };
  }

  const fileAttachments: FileAttachment[] = [];
  const modelBlocks: string[] = [];
  const displayBlocks: string[] = [];
  let body = prompt.trim();

  for (const att of attachments) {
    if (isTextPasteAttachment(att)) {
      const name = att.textPaste.displayName;
      modelBlocks.push(buildTextPasteModelBlock(name, att.textPaste.content));
      displayBlocks.push(buildTextPasteDisplayBlock(name));
    } else if (isTerminalPasteAttachment(att)) {
      // Handled below
    } else if (att.file) {
      fileAttachments.push(att);
    }
  }

  modelBlocks.push(...buildTerminalPasteBlocks(attachments));
  displayBlocks.push(...buildTerminalPasteDisplayBlocks(attachments));

  if (modelBlocks.length > 0) {
    body = [body, ...modelBlocks].filter(Boolean).join("\n\n");
  }

  let displayBody = prompt.trim();
  if (displayBlocks.length > 0) {
    displayBody = [displayBody, ...displayBlocks].filter(Boolean).join("\n\n");
  }

  return {
    modelPrompt: body,
    displayPrompt: displayBody,
    fileAttachments,
  };
}
