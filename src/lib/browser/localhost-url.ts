/**
 * Bare (schemeless) localhost URL detection for chat/terminal linkification.
 *
 * remark-gfm already autolinks full `http(s)://…` URLs, so this targets only the
 * schemeless form the agent/user commonly writes — e.g. "localhost:3000" or
 * "127.0.0.1:8080/login". A port is REQUIRED so the bare word "localhost" isn't
 * turned into a link. Kept dependency-free so it's cheap to unit-test.
 */

/** Global matcher for scanning a text run (used with String.matchAll / RegExp.exec).
 * The path segment must not END in sentence punctuation (. , ; : ! ? ' ") so a
 * trailing "." in prose isn't swallowed into the link. */
export const LOCALHOST_URL_RE =
  /(?<![\w.])(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?::\d+)(?:\/[^\s)]*[^\s).,;:!?'"])?/g;

/** True if the whole string is a bare localhost URL (with a port). */
export function isBareLocalhostUrl(s: string): boolean {
  const re = new RegExp(`^(?:${LOCALHOST_URL_RE.source})$`);
  return re.test(s.trim());
}
