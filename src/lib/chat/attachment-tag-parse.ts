/**
 * Index-based parsing for large paste/terminal attachment tags.
 * Avoids regex catastrophic backtracking on multi-hundred-line bodies.
 */

import { unescapeAttachmentTagBody } from "@/lib/chat/attachment-tag-escape";

export type ParsedAttachmentTag = {
  tag: "atlarix-text-attachment" | "atlarix-terminal-attachment";
  attributes: Record<string, string>;
  content: string;
  fullMatch: string;
  startIndex: number;
};

const ATTACHMENT_TAG_NAMES = [
  "atlarix-text-attachment",
  "atlarix-terminal-attachment",
] as const;

function unescapeXmlAttr(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&amp;/g, "&");
}

function parseAttributes(attributesStr: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  const attrPattern = /(\w+)="([^"]*)"/g;
  let attrMatch: RegExpExecArray | null;
  while ((attrMatch = attrPattern.exec(attributesStr)) !== null) {
    attributes[attrMatch[1]] = unescapeXmlAttr(attrMatch[2]);
  }
  return attributes;
}

function findAttachmentTagOpen(
  content: string,
  fromIndex: number,
): {
  tag: (typeof ATTACHMENT_TAG_NAMES)[number];
  openStart: number;
  openEnd: number;
  attrs: string;
} | null {
  let best: { tag: (typeof ATTACHMENT_TAG_NAMES)[number]; index: number } | null =
    null;
  for (const tag of ATTACHMENT_TAG_NAMES) {
    const needle = `<${tag}`;
    const idx = content.indexOf(needle, fromIndex);
    if (idx < 0) continue;
    if (!best || idx < best.index) {
      best = { tag, index: idx };
    }
  }
  if (!best) return null;

  const openStart = best.index;
  const gt = content.indexOf(">", openStart);
  if (gt < 0) return null;

  const openSlice = content.slice(openStart, gt + 1);
  const attrsMatch = openSlice.match(/^<[\w-]+\s*([^>]*)\/?>$/);
  const attrs = attrsMatch?.[1]?.trim() ?? "";

  return { tag: best.tag, openStart, openEnd: gt + 1, attrs };
}

/** Scan `content` for attachment tags (self-closing or paired). */
export function findAttachmentTagsInContent(content: string): ParsedAttachmentTag[] {
  const results: ParsedAttachmentTag[] = [];
  let cursor = 0;

  while (cursor < content.length) {
    const open = findAttachmentTagOpen(content, cursor);
    if (!open) break;

    const openStart = open.openStart;
    const openTagSlice = content.slice(openStart, open.openEnd);
    const isSelfClosing = /\/>\s*$/.test(openTagSlice);

    if (isSelfClosing) {
      const fullMatch = openTagSlice;
      results.push({
        tag: open.tag,
        attributes: parseAttributes(open.attrs),
        content: "",
        fullMatch,
        startIndex: openStart,
      });
      cursor = open.openEnd;
      continue;
    }

    const closeTag = `</${open.tag}>`;
    const closeIdx = content.indexOf(closeTag, open.openEnd);
    if (closeIdx < 0) break;

    const body = content.slice(open.openEnd, closeIdx);
    const fullMatch = content.slice(openStart, closeIdx + closeTag.length);
    results.push({
      tag: open.tag,
      attributes: parseAttributes(open.attrs),
      // Reverse the builder's tag-breakout neutralization so display/popover
      // text matches what the user pasted. fullMatch stays raw (re-splice safe).
      content: unescapeAttachmentTagBody(body),
      fullMatch,
      startIndex: openStart,
    });
    cursor = closeIdx + closeTag.length;
  }

  return results;
}

