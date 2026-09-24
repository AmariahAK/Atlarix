/**
 * Titles that are not titles: meta phrases ("Based on the conversation"),
 * placeholders, and tool/JSON debris. Pure, so the renderer can use it too.
 */

const LOW_QUALITY_TITLE_PATTERNS: RegExp[] = [
  /^based on (the |this )?conversation/i,
  /^based on (the |your )?messages?/i,
  /^conversation$/i,
  /^chat$/i,
  /^new chat$/i,
  /^untitled$/i,
  /^summary$/i,
  /^discussion$/i,
];

/** Tool args, JSON blobs, and tag debris are not valid session/chat titles. */
export function looksLikeToolOrStructuredDebrisTitle(title: string): boolean {
  const t = title.trim();
  if (!t) return true;
  if (/^json\s*[[{]/i.test(t)) return true;
  if (/^\s*[[{]/.test(t)) return true;
  if (t.startsWith("```")) return true;
  if (/atlarix-(?:tool|mcp)-/i.test(t)) return true;
  if (/<\/?[a-z][\w-]*[\s>]/i.test(t)) return true;
  if (/\baction\s*:\s*[\w-]+/i.test(t) && /\bpath\s*:\s*\S/i.test(t))
    return true;
  if (
    /\b(get_|search_|read_|write_|explore_|list_)[\w-]*/i.test(t) &&
    /[{[]/.test(t)
  ) {
    return true;
  }
  return false;
}

/** Reject generic / meta model outputs that are not real titles. */
export function isLowQualityGeneratedTitle(title: string): boolean {
  const t = title.trim();
  if (!t || t.length < 3) return true;
  if (LOW_QUALITY_TITLE_PATTERNS.some((p) => p.test(t))) return true;
  if (/^based on\b/i.test(t)) return true;
  if (looksLikeToolOrStructuredDebrisTitle(t)) return true;
  return false;
}
