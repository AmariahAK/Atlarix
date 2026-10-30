/**
 * Canonicalize provider-emitted thinking tags to ONE tag name, and drop stray
 * closers.
 *
 * Every reasoning provider spells its thinking wrapper differently — `<think>`
 * (DeepSeek and most OpenAI-compatible reasoners), `<thinking>` (Anthropic-style
 * prose), `<redacted_thinking>` (Anthropic's redacted blocks). Four separate call
 * sites used to normalize these inline, and all four did it the same WRONG way:
 * they rewrote the OPENER to `redacted_thinking` but the CLOSER to `</think>`, so
 * the pair no longer matched. Every downstream consumer then mis-handled it:
 *
 *  - `answer-display` treated the opener as unclosed and `drop-through-eof` ate
 *    the rest of the message (a `<thinking>`-led reply rendered as empty).
 *  - `assistant-message-parts` / `AtlarixMarkdownParser` count openers vs closers
 *    and append the missing ones at the END, so the answer was swallowed into the
 *    thinking block.
 *  - `extract-thinking-from-content` did the same, which is why the Thoughts card
 *    captured the visible answer for EVERY `<think>`-emitting model.
 *
 * Fixing it in one place is the point: the bug was four copies of one mistake, so
 * the fix must not be four copies of one correction.
 *
 * Renderer-safe: pure string work, no imports, no Node/Electron surface.
 */

/**
 * Tag names that mean "model reasoning". All of them normalize to
 * `CANONICAL_THOUGHT_TAG` so downstream scanners only ever match one name.
 * `redacted_thinking` is the canonical spelling because it is the one the
 * markdown parser already renders and `useCopyToClipboard` already strips.
 */
export const CANONICAL_THOUGHT_TAG = "redacted_thinking";

/** Variants normalized INTO the canonical tag (canonical itself excluded). */
const THOUGHT_TAG_VARIANTS = ["thinking", "think"] as const;

/**
 * Tags whose stray closers are dropped. `reasoning` is included because it is a
 * thought tag every consumer already strips, and an orphan `</reasoning>` would
 * leak into prose exactly like `</think>` did.
 */
const ORPHAN_CLOSER_TAGS = [CANONICAL_THOUGHT_TAG, "reasoning"] as const;

/**
 * Remove closers with no matching opener, leaving well-formed pairs untouched.
 *
 * An unmatched OPENER is legitimate mid-stream (the block hasn't finished
 * arriving) and callers deliberately handle it — so it is left alone. An
 * unmatched CLOSER never is: a well-formed stream always sends the opener first.
 * In practice it happens when a provider emits reasoning on a separate response
 * field but still writes the closing tag into `content` (observed with MiniMax
 * M3: a bare `</think>` rendered in the middle of the reply).
 */
function stripUnmatchedClosers(content: string, tagName: string): string {
  // `</\n reasoning >` is a closer too: gpt-oss over Bedrock broke a closer across
  // a newline and the stray half rendered as prose (CLI QA, 2026-10-30).
  const scan = new RegExp(`<\\s*${tagName}(?:\\s[^>]*)?>|<\\s*/\\s*${tagName}\\s*>`, "gi");
  const drop: Array<[number, number]> = [];
  let depth = 0;
  let m: RegExpExecArray | null;
  while ((m = scan.exec(content)) !== null) {
    if (m[0].startsWith("</")) {
      if (depth > 0) depth--;
      else drop.push([m.index, m.index + m[0].length]);
    } else {
      depth++;
    }
  }
  if (drop.length === 0) return content;
  let out = "";
  let cursor = 0;
  for (const [start, end] of drop) {
    out += content.slice(cursor, start);
    cursor = end;
  }
  return out + content.slice(cursor);
}

/**
 * Canonicalize thinking tags and drop stray closers.
 *
 * Attributes on the opener are preserved (the parser reads them), and matching is
 * case-insensitive because providers are inconsistent about casing.
 */
export function normalizeThinkingTags(content: string): string {
  if (!content) return "";
  let out = content;
  for (const variant of THOUGHT_TAG_VARIANTS) {
    out = out
      .replace(
        new RegExp(`<\\s*${variant}(\\s[^>]*)?>`, "gi"),
        (_m, attrs = "") => `<${CANONICAL_THOUGHT_TAG}${attrs}>`,
      )
      .replace(
        new RegExp(`<\\s*/\\s*${variant}\\s*>`, "gi"),
        `</${CANONICAL_THOUGHT_TAG}>`,
      );
  }
  for (const tag of ORPHAN_CLOSER_TAGS) {
    out = stripUnmatchedClosers(out, tag);
  }
  return out;
}
