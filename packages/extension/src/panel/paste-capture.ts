/**
 * A long paste becomes an attachment, not a wall of text in the composer.
 *
 * THE DESKTOP'S THRESHOLDS, EXACTLY — `src/lib/chat/text-paste-attachment.ts`.
 * Copied rather than re-chosen because the two surfaces should behave the same
 * on the same paste, and because these numbers have been lived with.
 *
 * NO CONFIRMATION DIALOG. The desktop has a `TextPastePreviewDialog`, and it is
 * easy to mistake it for a prompt — it is not. It is a viewer opened later by
 * clicking the chip. Capture itself is silent, and asking "shall I make this an
 * attachment?" on every log paste would be a modal between a person and the
 * thing they were in the middle of doing.
 */

/** Strictly greater than this many characters, on the TRIMMED text. */
export const LONG_PASTE_CHARS = 500;
/** Strictly greater than this many lines. */
export const LONG_PASTE_LINES = 20;

export function pasteLineCount(content: string): number {
  return (content.match(/\n/g) || []).length + 1;
}

/**
 * Is this paste big enough to become a chip?
 *
 * EITHER threshold triggers: a 600-character paragraph and a 30-line stack trace
 * are both things you want out of the composer, and neither crosses the other's
 * bound. Both are strict — exactly 500 characters stays inline.
 */
export function shouldCaptureAsPaste(plainText: string): boolean {
  const trimmed = plainText.trim();
  if (!trimmed) return false;
  return (
    trimmed.length > LONG_PASTE_CHARS ||
    pasteLineCount(trimmed) > LONG_PASTE_LINES
  );
}

/** What the chip is called. U+00B7, matching the desktop byte for byte. */
export function pasteDisplayName(content: string): string {
  const n = pasteLineCount(content);
  return `Pasted text · ${n} line${n === 1 ? "" : "s"}`;
}

/**
 * The plain text of a paste, falling back to the HTML flavour.
 *
 * NOT OPTIONAL. Notes, TextEdit and every word processor populate `text/html`
 * and leave `text/plain` empty, so without this a long paste from any of them
 * falls straight through the check and lands inline — the exact case the
 * feature exists for, failing silently.
 */
export function clipboardPlainText(data: DataTransfer): string {
  const plain = data.getData("text/plain");
  if (plain && plain.trim()) return plain;
  const html = data.getData("text/html");
  if (!html) return plain;
  try {
    const doc = new DOMParser().parseFromString(html, "text/html");
    return doc.body?.textContent ?? plain;
  } catch {
    return plain;
  }
}

/**
 * A cheap signature for "we already have this one".
 *
 * Length plus both ends rather than the whole string: a double-paste of a
 * megabyte should not cost a megabyte comparison, and two different files that
 * agree on length AND their first and last 64 characters is not a case worth
 * defending against. The desktop's rule.
 */
export function pasteSignature(content: string): string {
  return `${content.length}:${content.slice(0, 64)}:${content.slice(-64)}`;
}
