/**
 * First sentence of a block of prose, flattened and length-capped.
 *
 * The primitive behind every "pointers, not payloads" surface in the app: the
 * skills index (one line per skill, body read on demand) and the per-mode tool
 * reveal (one line per peripheral tool, full description fetched on demand).
 * Shared so the two cannot drift into two different notions of "one line".
 */
export function firstSentence(text: string, max = 200): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (!flat) return "";
  const stop = flat.search(/(?<=[.!?])\s/);
  const cut = (stop > 0 ? flat.slice(0, stop + 1) : flat).trim();
  return cut.length > max ? `${cut.slice(0, max - 1)}…` : cut;
}
