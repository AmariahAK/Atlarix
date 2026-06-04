/**
 * Shared truncation helpers (single source of truth — previously duplicated
 * in ContextAssembler / context-budget-pruning / project-memory and
 * tools/search / tools/file).
 */

import { estimateTokens } from "@/ipc/utils/token_utils";

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
  return `${content.slice(0, Math.max(0, lo))}${suffix}`;
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
  const tailWindow = content.slice(-tailWindowChars);
  let lo = 0;
  let hi = tailWindow.length;
  while (lo < hi) {
    const mid = Math.floor((lo + hi + 1) / 2);
    if (estimateTokens(tailWindow.slice(tailWindow.length - mid)) <= tailTokens) lo = mid;
    else hi = mid - 1;
  }
  const tail = tailWindow.slice(tailWindow.length - lo);
  const omittedChars = Math.max(0, content.length - head.length - tail.length);
  if (omittedChars === 0) {
    return { text: content, omittedChars: 0 };
  }
  return {
    text: `${head}\n\n… [${omittedChars.toLocaleString("en-US")} chars omitted] …\n\n${tail}`,
    omittedChars,
  };
}

/** UTF-8-safe byte cap; leaves `margin` bytes of head-room for the `suffix` note. */
export function truncateUtf8ByBytes(
  text: string,
  maxBytes: number,
  options?: { margin?: number; suffix?: string },
): string {
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= maxBytes) return text;
  const margin = options?.margin ?? 100;
  const suffix = options?.suffix ?? "\n\n… [truncated: exceeded max_bytes]";
  const cut = buf.subarray(0, Math.max(0, maxBytes - margin));
  return cut.toString("utf8") + suffix;
}
