/**
 * Tag-breakout neutralization for attachment / envelope BODIES.
 *
 * Attachment model-blocks (<atlarix-text-attachment>, …) and the
 * <untrusted-data> envelope wrap attacker-influenceable content (pasted text,
 * PR titles, MCP/web/command output). Their bodies are inserted between literal
 * open/close tags, so a body containing `</atlarix-text-attachment>` — or a
 * spoofed `<system-reminder>` claiming harness authority — would break out of
 * the wrapper and inject free-floating instructions into the turn.
 *
 * This escapes ONLY the `<` that opens such a control tag (not every `<`, which
 * would `&lt;`-mangle every HTML/TSX code paste). It is exactly reversible:
 * pre-existing `&`-sequences that could decode into a control tag are escaped
 * first, so `unescapeAttachmentTagBody` is a precise inverse. No imports → this
 * leaf is safe to use from every builder and the parser without cycles.
 */

// Control tags whose opening `<` must be neutralized inside a body.
const CONTROL_TAG = String.raw`\/?(?:atlarix-[\w-]+|system-reminder|untrusted-data)[\s>/]`;

// A `<` (optionally already once-escaped as `&lt;`) that begins a control tag.
const ESCAPED_AMP = new RegExp(
  String.raw`&(?=(?:amp;)*lt;` + CONTROL_TAG + ")",
  "gi",
);
const RAW_LT = new RegExp(String.raw`<(?=` + CONTROL_TAG + ")", "gi");

/** Neutralize control-tag openings in an untrusted body. Reversible. */
export function escapeAttachmentTagBody(body: string): string {
  // Escape the ampersand of any pre-existing `&lt;<control-tag>` chain first so
  // the raw-`<` pass below cannot collide with it on the way back out.
  return body.replace(ESCAPED_AMP, "&amp;").replace(RAW_LT, "&lt;");
}

// Inverse: a `&lt;` (with any leading `&amp;` chain) that precedes a control tag.
const UNESCAPE_LT = new RegExp(String.raw`&lt;(?=` + CONTROL_TAG + ")", "gi");
const UNESCAPE_AMP = new RegExp(
  String.raw`&amp;(?=(?:amp;)*lt;` + CONTROL_TAG + ")",
  "gi",
);

/** Exact inverse of escapeAttachmentTagBody (used on the display/parse path). */
export function unescapeAttachmentTagBody(body: string): string {
  // Reverse order: restore the raw `<` first, then collapse one `&amp;` layer.
  return body.replace(UNESCAPE_LT, "<").replace(UNESCAPE_AMP, "&");
}
