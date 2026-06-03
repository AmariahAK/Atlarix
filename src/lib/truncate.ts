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
