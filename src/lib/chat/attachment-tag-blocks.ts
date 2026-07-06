import type { FileAttachment } from "@/ipc/ipc_types";
import {
  buildTerminalPasteBlocks,
  buildTerminalPasteDisplayBlocks,
  isTerminalPasteAttachment,
} from "@/lib/chat/terminal-paste-attachment";
import {
  isTextPasteAttachment,
} from "@/lib/chat/text-paste-attachment";
import {
  isMentionAttachment,
  mentionToken,
} from "@/lib/chat/mention-attachment";
import {
  isBackgroundJobAttachment,
  buildBackgroundJobModelBlock,
  buildBackgroundJobDisplayBlock,
} from "@/lib/chat/background-job-attachment";
import { escapeAttachmentTagBody } from "@/lib/chat/attachment-tag-escape";

export function escapeXmlAttr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;");
}

function buildTextPasteModelBlock(name: string, body: string): string {
  // Body is untrusted (pasted text / automation event) — neutralize tag-breakout.
  return `<atlarix-text-attachment filename="${escapeXmlAttr(name)}">\n${escapeAttachmentTagBody(body)}\n</atlarix-text-attachment>`;
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
  // `@file:`/`@dir:` tokens reconstructed from mention chips. They go into BOTH
  // prompts: the model prompt so parseContextMentions expands them, the display
  // prompt so the sent message still shows what was referenced.
  const mentionTokens: string[] = [];
  let body = prompt.trim();

  for (const att of attachments) {
    if (isMentionAttachment(att)) {
      mentionTokens.push(mentionToken(att));
    } else if (isTextPasteAttachment(att)) {
      const name = att.textPaste.displayName;
      modelBlocks.push(buildTextPasteModelBlock(name, att.textPaste.content));
      displayBlocks.push(buildTextPasteDisplayBlock(name));
    } else if (isBackgroundJobAttachment(att)) {
      modelBlocks.push(buildBackgroundJobModelBlock(att));
      displayBlocks.push(buildBackgroundJobDisplayBlock(att));
    } else if (isTerminalPasteAttachment(att)) {
      // Handled below
    } else if (att.file) {
      fileAttachments.push(att);
    }
  }

  modelBlocks.push(...buildTerminalPasteBlocks(attachments));
  displayBlocks.push(...buildTerminalPasteDisplayBlocks(attachments));

  const mentionLine = mentionTokens.join(" ");

  if (mentionLine || modelBlocks.length > 0) {
    body = [body, mentionLine, ...modelBlocks].filter(Boolean).join("\n\n");
  }

  let displayBody = prompt.trim();
  if (mentionLine || displayBlocks.length > 0) {
    displayBody = [displayBody, mentionLine, ...displayBlocks]
      .filter(Boolean)
      .join("\n\n");
  }

  return {
    modelPrompt: body,
    displayPrompt: displayBody,
    fileAttachments,
  };
}
