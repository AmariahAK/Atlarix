/** http(s) URLs in plain text; trailing punctuation is the sentence's, not the URL's. */
export const URL_IN_TEXT = /\bhttps?:\/\/[^\s<>()"'`]+[^\s<>()"'`.,;:!?]/g;

/** Each distinct http(s) URL in `text`, in order. */
export function urlsIn(text: string): string[] {
  return [...new Set([...text.matchAll(URL_IN_TEXT)].map((m) => m[0]))];
}
