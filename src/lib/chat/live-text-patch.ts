/**
 * Applies a live-text patch from `chat:response:chunk` (see
 * response-chunk-update.ts): keep the first `start` characters of what we hold,
 * then the patch text. Returns null when it doesn't fit our copy (a missed
 * chunk), so the caller keeps what it has until the next full message list.
 */
export interface LiveTextPatch {
  messageId?: unknown;
  start?: unknown;
  text?: unknown;
  length?: unknown;
}

export function applyLiveTextPatch(
  current: string,
  patch: LiveTextPatch | undefined,
): string | null {
  if (!patch) return null;
  const { start, text, length } = patch;
  if (typeof start !== "number" || typeof text !== "string") return null;
  if (start < 0 || start > current.length) return null;
  const next = current.slice(0, start) + text;
  if (typeof length === "number" && next.length !== length) return null;
  return next;
}
