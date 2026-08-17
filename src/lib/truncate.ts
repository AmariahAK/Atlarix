/**
 * Shared truncation helpers (single source of truth — previously duplicated
 * in ContextAssembler / context-budget-pruning / project-memory and
 * tools/search / tools/file).
 */

import { estimateTokens } from "@/ipc/utils/token_utils";

/**
 * Cut a JS string at `end` without splitting a surrogate pair.
 *
 * A non-BMP character (emoji, and much CJK extension / historic script text) is
 * TWO JS code units, so slicing by index can land between them and leave a lone
 * high surrogate at the end. That is not merely a mangled glyph: these strings
 * are tool output on their way to a model, and a lone surrogate is not valid
 * UTF-8, so `JSON.stringify` emits an unpaired `\udXXX` escape that some
 * providers reject outright — turning "your grep matched an emoji" into a failed
 * turn. Dropping the orphan costs one character.
 */
function sliceWithoutSplittingSurrogate(content: string, end: number): string {
  const cut = Math.max(0, Math.min(end, content.length));
  if (cut > 0 && cut < content.length) {
    const last = content.charCodeAt(cut - 1);
    // High surrogate at the very end means its low half was just cut away.
    if (last >= 0xd800 && last <= 0xdbff) return content.slice(0, cut - 1);
  }
  return content.slice(0, cut);
}

/**
 * The mirror image: take a suffix starting at `start` without leaving an orphan
 * LOW surrogate at the front. Cutting from the other end has exactly the same
 * failure, and tool output is truncated from both ends (head + tail view).
 */
function sliceSuffixWithoutSplittingSurrogate(
  content: string,
  start: number,
): string {
  const from = Math.max(0, Math.min(start, content.length));
  if (from > 0 && from < content.length) {
    const first = content.charCodeAt(from);
    if (first >= 0xdc00 && first <= 0xdfff) return content.slice(from + 1);
  }
  return content.slice(from);
}

/** Binary-search the longest prefix whose estimated tokens fit `maxTokens`; appends `suffix` when trimmed. */
export function truncateToTokens(
  content: string,
  maxTokens: number,
  suffix = "\n\n...(trimmed)",
): string {
  if (estimateTokens(content) <= maxTokens) return content;
  let lo = 0;
  let hi = content.length;
  while (lo < hi) {
    const mid = Math.floor((lo + hi + 1) / 2);
    if (estimateTokens(content.slice(0, mid)) <= maxTokens) lo = mid;
    else hi = mid - 1;
  }
  return `${sliceWithoutSplittingSurrogate(content, lo)}${suffix}`;
}

/**
 * v10.1 tool-output budgets: head + tail token view. Keeps the first
 * `headTokens` and last `tailTokens` worth of text with an omitted-range
 * marker between them — tails carry exit codes / error summaries / final
 * test results that head-only truncation loses.
 */
export function headTailTruncateToTokens(
  content: string,
  headTokens: number,
  tailTokens: number,
): { text: string; omittedChars: number } {
  // Char windows bound tokenizer input (≈8 chars/token worst case) — never
  // run the exact tokenizer over multi-hundred-KB outputs.
  const headWindowChars = headTokens * 8;
  const tailWindowChars = tailTokens * 8;
  if (
    content.length <= headWindowChars + tailWindowChars &&
    estimateTokens(content) <= headTokens + tailTokens
  ) {
    return { text: content, omittedChars: 0 };
  }
  const head = truncateToTokens(content.slice(0, headWindowChars), headTokens, "");
  // Longest suffix of the tail window whose estimated tokens fit `tailTokens`.
  const tailWindow = sliceSuffixWithoutSplittingSurrogate(
    content,
    Math.max(0, content.length - tailWindowChars),
  );
  let lo = 0;
  let hi = tailWindow.length;
  while (lo < hi) {
    const mid = Math.floor((lo + hi + 1) / 2);
    if (estimateTokens(tailWindow.slice(tailWindow.length - mid)) <= tailTokens) lo = mid;
    else hi = mid - 1;
  }
  const tail = sliceSuffixWithoutSplittingSurrogate(
    tailWindow,
    tailWindow.length - lo,
  );
  const omittedChars = Math.max(0, content.length - head.length - tail.length);
  if (omittedChars === 0) {
    return { text: content, omittedChars: 0 };
  }
  return {
    text: `${head}\n\n… [${omittedChars.toLocaleString("en-US")} chars omitted] …\n\n${tail}`,
    omittedChars,
  };
}

/**
 * UTF-8-safe byte cap; leaves `margin` bytes of head-room for the `suffix` note.
 *
 * "UTF-8-safe" needs qualifying: `Buffer#toString` never produces a lone
 * surrogate, but it does replace a half-copied multi-byte sequence with U+FFFD,
 * so the last character came back as `�`. We drop that partial character
 * instead — one glyph lost either way, without inventing one that was not there.
 */
export function truncateUtf8ByBytes(
  text: string,
  maxBytes: number,
  options?: { margin?: number; suffix?: string },
): string {
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= maxBytes) return text;
  const margin = options?.margin ?? 100;
  const suffix = options?.suffix ?? "\n\n… [truncated: exceeded max_bytes]";
  let end = Math.max(0, maxBytes - margin);
  // Walk back off any UTF-8 continuation bytes (10xxxxxx) to a character start.
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end--;
  const cut = buf.subarray(0, end);
  return cut.toString("utf8") + suffix;
}
