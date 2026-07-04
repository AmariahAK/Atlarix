/**
 * W5 (v14.8.11) — keep attachment chips while editing a sent message.
 *
 * A sent user message's display content carries self-closing attachment STUB
 * tags (`<atlarix-text-attachment … />`, `<atlarix-terminal-attachment … />`);
 * the normal view parses them into chips, but the edit textarea used to bind
 * the RAW content — so attachments appeared as literal XML wording. Split the
 * prose from the tags for editing, render the chips read-only above the box,
 * and re-splice the tags on save.
 *
 * Re-splice policy: stripped tags are appended in their original order at the
 * end of the edited text — positional re-insertion is fragile after arbitrary
 * edits, and stubs carry no body (the model directive is rebuilt from the
 * message's pasteAttachments at dispatch), so order relative to prose is
 * cosmetic only.
 */

import {
  findAttachmentTagsInContent,
  type ParsedAttachmentTag,
} from "@/lib/chat/attachment-tag-parse";

export type EditAttachmentTagSplit = {
  /** The editable prose with attachment tags removed. */
  text: string;
  /** Stripped tags in original order (full raw markup, ready to re-splice). */
  tags: ParsedAttachmentTag[];
};

export function splitAttachmentTagsForEdit(content: string): EditAttachmentTagSplit {
  const tags = findAttachmentTagsInContent(content);
  if (tags.length === 0) return { text: content, tags: [] };
  let text = "";
  let cursor = 0;
  for (const tag of tags) {
    text += content.slice(cursor, tag.startIndex);
    cursor = tag.startIndex + tag.fullMatch.length;
  }
  text += content.slice(cursor);
  // Collapse the whitespace holes the removed tags leave behind.
  return { text: text.replace(/\n{3,}/g, "\n\n").trim(), tags };
}

export function rejoinAttachmentTags(
  text: string,
  tags: ParsedAttachmentTag[],
): string {
  if (tags.length === 0) return text;
  const blocks = tags.map((t) => t.fullMatch);
  return [text.trim(), ...blocks].filter(Boolean).join("\n\n");
}
