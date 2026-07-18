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

import {
  escapeAttachmentTagBody,
  unescapeAttachmentTagBody,
} from "@/lib/chat/attachment-tag-escape";
import { escapeXmlAttr } from "@/lib/chat/attachment-tag-blocks";

const OPEN_PREFIX = "<untrusted-data";
export const UNTRUSTED_DATA_CLOSE = "</untrusted-data>";

// A leading `<untrusted-data source="…">` open tag (with optional surrounding
// whitespace and the single trailing newline the wrapper adds).
const OPEN_TAG = /^\s*<untrusted-data\b[^>]*>\n?/i;
// A trailing `</untrusted-data>` close tag (with optional surrounding whitespace
// and the single leading newline the wrapper adds).
const CLOSE_TAG = /\n?<\/untrusted-data>\s*$/i;

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

/**
 * DISPLAY-ONLY inverse of `wrapUntrustedData`: strip the `<untrusted-data …>` …
 * `</untrusted-data>` envelope and reverse the body's control-tag neutralization
 * so tool cards show the real content, not the framing the MODEL needs.
 *
 * Never run this on the model-facing or persisted string — the envelope is the
 * injection defense and must survive reload/replay/re-dispatch. Returns the
 * input unchanged when it is not a wrapped envelope.
 */
export function stripUntrustedDataEnvelope(s: string): string {
  if (!s) return s;
  if (!OPEN_TAG.test(s) || !CLOSE_TAG.test(s)) return s;
  const inner = s.replace(OPEN_TAG, "").replace(CLOSE_TAG, "");
  return unescapeAttachmentTagBody(inner);
}
