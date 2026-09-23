/**
 * Makes the one URL Atlarix ever puts in an error message clickable.
 *
 * ══ WHY THIS IS NOT A GENERAL LINKIFIER ══
 *
 * `errorBubble` sets `textContent`, so "Not enough credit to start a turn —
 * you need at least $2.00. Top up at atlarix.dev/account." rendered as plain
 * text and the person who ran out of credit had to retype an address off the
 * screen. That is the whole bug.
 *
 * The obvious fix — find any URL in the string and link it — is the wrong one
 * here, and the reason is where the string comes from. `CoreError.message` is
 * written from a PROVIDER's response body. Turning arbitrary text from a remote
 * service into a clickable link in a surface that holds the user's session is
 * the shape of a phishing primitive, not a convenience.
 *
 * So: exactly two literals are recognised, and the `href` is a CONSTANT in this
 * file rather than anything taken from the matched text. A message carrying
 * some other URL keeps it as plain, unclickable prose, which is the correct
 * outcome for text nobody here wrote.
 *
 * Built with `createElement` and `textContent` — never `innerHTML` — for the
 * same reason `markdown.ts` carries that rule: the input is downstream of
 * things Atlarix does not control.
 */

/** The only addresses ever linked. Never read from the message. */
export const ACCOUNT_URL = "https://atlarix.dev/account";
export const PRICING_URL = "https://atlarix.dev/pricing";

/** The literals `describeError` writes, matched case-insensitively. */
const LINKED_TEXT = /atlarix\.dev\/(account|pricing)/gi;

function hrefFor(matched: string): string {
  return /pricing/i.test(matched) ? PRICING_URL : ACCOUNT_URL;
}

/**
 * Split a message into text and at most-one-per-occurrence anchors.
 *
 * Returns plain text nodes when there is nothing to link, so the caller can
 * append the result unconditionally.
 */
export function errorMessageNodes(text: string): Node[] {
  const nodes: Node[] = [];
  let cursor = 0;

  // `matchAll` needs the `g` flag and a fresh index each call; the regex is
  // module-level, so reset it rather than trusting the last caller.
  LINKED_TEXT.lastIndex = 0;
  for (const match of text.matchAll(LINKED_TEXT)) {
    const at = match.index ?? 0;
    if (at > cursor) {
      nodes.push(document.createTextNode(text.slice(cursor, at)));
    }
    const link = document.createElement("a");
    link.href = hrefFor(match[0]);
    // The visible text is what the message said; the destination is ours.
    link.textContent = match[0];
    link.target = "_blank";
    // `noopener` is the one that matters — a new tab opened from an extension
    // page must not get a handle back to it.
    link.rel = "noopener noreferrer";
    nodes.push(link);
    cursor = at + match[0].length;
  }

  if (cursor < text.length) {
    nodes.push(document.createTextNode(text.slice(cursor)));
  }
  return nodes;
}
