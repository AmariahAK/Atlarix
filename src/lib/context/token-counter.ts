import { getTokenizer } from "@anthropic-ai/tokenizer";

/**
 * ONE tokenizer for the process. The package's `countTokens` builds a new
 * Tiktoken (parsing the whole BPE table) on every call and frees it: the first
 * turn's tool-surface measure made 56 such calls, 1.4s of synchronous work that
 * froze the CLI right after Enter, before it could even draw the message
 * (owner, 2026-10-05: "it kind of hangs for a second before it sends"). Built
 * once and kept, the same 56 counts take ~18ms. Same encoding as countTokens.
 */
let tokenizer: ReturnType<typeof getTokenizer> | null = null;
function countTokens(text: string): number {
  tokenizer ??= getTokenizer();
  return tokenizer.encode(text.normalize("NFKC"), "all").length;
}

/**
 * S18 (v14.8.11, data-backed): memoize per-text token counts. The W10 gap
 * attribution showed full-history exact tokenization running ~3× per turn
 * (context-budget span + two equal unwrapped gaps, all growing with session
 * length — 91→244→467ms in one live session). History messages are immutable
 * strings re-counted every turn, so an LRU turns all but the newest text into
 * O(1) hits. Keys hold references to strings that are alive in the transport
 * anyway; the entry cap bounds retained garbage after compaction.
 */
const TOKEN_COUNT_MEMO = new Map<string, number>();
const TOKEN_COUNT_MEMO_MAX = 4096;
/** Tiny strings are cheaper to count than to cache. */
const TOKEN_COUNT_MEMO_MIN_CHARS = 64;

export function exactTokenCount(
  messages: { role: string; content: string }[],
): number {
  try {
    const combinedText = messages
      .map((m) => `${m.role}: ${m.content}`)
      .join("\n");
    return countTokens(combinedText);
  } catch {
    const totalChars = messages.map((m) => m.content).join("").length;
    return Math.ceil(totalChars / 4);
  }
}

export function exactTokenCountText(text: string): number {
  if (text.length >= TOKEN_COUNT_MEMO_MIN_CHARS) {
    const hit = TOKEN_COUNT_MEMO.get(text);
    if (hit !== undefined) {
      // Refresh recency (Map preserves insertion order → delete+set = LRU).
      TOKEN_COUNT_MEMO.delete(text);
      TOKEN_COUNT_MEMO.set(text, hit);
      return hit;
    }
  }
  let count: number;
  try {
    count = countTokens(text);
  } catch {
    count = Math.ceil(text.length / 4);
  }
  if (text.length >= TOKEN_COUNT_MEMO_MIN_CHARS) {
    TOKEN_COUNT_MEMO.set(text, count);
    if (TOKEN_COUNT_MEMO.size > TOKEN_COUNT_MEMO_MAX) {
      const oldest = TOKEN_COUNT_MEMO.keys().next().value;
      if (oldest !== undefined) TOKEN_COUNT_MEMO.delete(oldest);
    }
  }
  return count;
}
