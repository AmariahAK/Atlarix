/**
 * Display-only URL helpers (do not mutate stored values).
 */

/** Hostname without leading `www.`; returns the input unchanged when it isn't a valid URL. */
export function extractDomain(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/** Display-only URL shortening for settings UI. */
export function truncateUrl(url: string, max = 48): string {
  const trimmed = url.trim();
  if (!trimmed) return "";
  if (trimmed.length <= max) return trimmed;

  try {
    const parsed = new URL(trimmed);
    const host = parsed.host;
    const pathParts = parsed.pathname.split("/").filter(Boolean);
    const lastSegment = pathParts[pathParts.length - 1] ?? "";
    const prefix = `${parsed.protocol}//${host}`;
    const suffix = lastSegment ? `…/${lastSegment}` : "…";
    const candidate = prefix + suffix;
    if (candidate.length <= max) return candidate;
    const room = Math.max(8, max - 1);
    return `${prefix.slice(0, room)}…`;
  } catch {
    if (trimmed.length <= max) return trimmed;
    const head = Math.ceil(max * 0.55);
    const tail = Math.max(4, max - head - 1);
    return `${trimmed.slice(0, head)}…${trimmed.slice(-tail)}`;
  }
}
