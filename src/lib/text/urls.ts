/**
 * http(s) URLs in plain text. Trailing punctuation is the sentence's, not the
 * URL's, and so is a ")" that closes prose around it; a balanced "(…)" inside
 * the URL is its own (Wikipedia's `Rust_(programming_language)`: QA E2).
 */
export const URL_IN_TEXT =
  /\bhttps?:\/\/(?:[^\s<>()"'`]|\([^\s<>()"'`]*\))*(?:[^\s<>()"'`.,;:!?]|\([^\s<>()"'`]*\))/g;

/** Each distinct http(s) URL in `text`, in order. */
export function urlsIn(text: string): string[] {
  return [...new Set([...text.matchAll(URL_IN_TEXT)].map((m) => m[0]))];
}
