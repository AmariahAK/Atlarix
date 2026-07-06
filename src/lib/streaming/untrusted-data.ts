/**
 * External-content envelope.
 *
 * Content that originates OUTSIDE the trusted conversation — web page/search
 * results, MCP tool responses, shell command output, automation trigger
 * context (PR titles, Slack messages) — may contain adversarial instructions
 * ("ignore previous instructions and …"). This is a DIFFERENT trust class from
 * `<system-reminder>` (which marks TRUSTED harness guidance): external data is
 * the opposite — never authoritative.
 *
 * `wrapUntrustedData` marks such content so the model treats it as data, not
 * instructions (the system-prompt clause names this tag). The body's own
 * control-tag sequences are neutralized (via escapeAttachmentTagBody) so the
 * envelope can't be broken out of by planted `</untrusted-data>` text.
 */

import { escapeAttachmentTagBody } from "@/lib/chat/attachment-tag-escape";
import { escapeXmlAttr } from "@/lib/chat/attachment-tag-blocks";

const OPEN_PREFIX = "<untrusted-data";
export const UNTRUSTED_DATA_CLOSE = "</untrusted-data>";

/**
 * Wrap external content in an <untrusted-data source="…"> envelope. Returns the
 * body unchanged when empty (nothing to frame) or already wrapped (avoids
 * double-tagging when composing).
 */
export function wrapUntrustedData(source: string, body: string): string {
  if (!body) return body;
  if (body.trimStart().startsWith(OPEN_PREFIX)) return body;
  return `${OPEN_PREFIX} source="${escapeXmlAttr(source)}">\n${escapeAttachmentTagBody(body)}\n${UNTRUSTED_DATA_CLOSE}`;
}
