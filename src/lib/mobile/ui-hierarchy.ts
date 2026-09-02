/**
 * `adb shell uiautomator dump` → element refs, the direct analogue of
 * `a11y-snapshot.ts` for a phone screen.
 *
 * WHY REFS AND NOT COORDINATES
 * ----------------------------
 * `adb shell input tap X Y` is the obvious primitive and the wrong contract. A
 * coordinate is correct for exactly one screen size and density, so a script
 * that works on a Pixel 7 emulator silently taps empty space on a tablet — and
 * "silently" is the problem: the tap SUCCEEDS, nothing happens, and the agent
 * reads an unchanged screen and concludes the app is broken.
 *
 * The dump gives `bounds`, `resource-id`, `text`, `content-desc` and `clickable`
 * per node — enough to name an element the way a browser ref does and resolve it
 * to a centre point at act time, against the CURRENT screen.
 *
 * WHY A REGEX AND NOT AN XML PARSER
 * ---------------------------------
 * The dump is machine-generated, single-line, attribute-only XML with no
 * namespaces, entities beyond the standard five, or mixed content. Adding an XML
 * dependency to read it would be cost without a defect to point at. If that ever
 * stops being true the failure is visible (zero elements parsed from a non-empty
 * dump), not silent.
 */

export type MobileElement = {
  ref: string;
  /** Short class name — "Button", "EditText". */
  role: string;
  /** Best available human label: text, else content-desc, else resource-id tail. */
  name: string;
  resourceId?: string;
  clickable: boolean;
  editable: boolean;
  /** Centre point, for act-time resolution. */
  center: { x: number; y: number };
  bounds: { left: number; top: number; right: number; bottom: number };
};

const NODE_RE = /<node\s([^>]*?)\/?>/g;
const ATTR_RE = /([\w-]+)="([^"]*)"/g;

function decode(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function parseBounds(
  raw: string,
): { left: number; top: number; right: number; bottom: number } | null {
  // "[0,132][1080,264]"
  const m = raw.match(/\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]/);
  if (!m) return null;
  const [left, top, right, bottom] = [m[1], m[2], m[3], m[4]].map(Number);
  if (right <= left || bottom <= top) return null;
  return { left: left!, top: top!, right: right!, bottom: bottom! };
}

/**
 * Parse a dump into refs.
 *
 * `interactiveOnly` keeps clickable/editable/checkable/scrollable nodes. A phone
 * screen dumps 150+ nodes, most of them layout containers with no text, so the
 * default read has to be the interactive subset or the result is mostly padding.
 */
export function parseUiHierarchy(
  xml: string,
  opts?: { interactiveOnly?: boolean; max?: number },
): { elements: MobileElement[]; total: number } {
  const interactiveOnly = opts?.interactiveOnly ?? true;
  const max = opts?.max ?? 120;
  const all: MobileElement[] = [];

  NODE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  let seq = 0;
  while ((m = NODE_RE.exec(xml))) {
    const attrs: Record<string, string> = {};
    ATTR_RE.lastIndex = 0;
    let a: RegExpExecArray | null;
    while ((a = ATTR_RE.exec(m[1]!))) attrs[a[1]!] = decode(a[2]!);

    const bounds = parseBounds(attrs.bounds ?? "");
    if (!bounds) continue;

    const clickable = attrs.clickable === "true";
    const editable =
      attrs.class?.endsWith("EditText") === true || attrs.focusable === "true";
    const interactive =
      clickable ||
      attrs.clickable === "true" ||
      attrs.checkable === "true" ||
      attrs.scrollable === "true" ||
      attrs.long_clickable === "true" ||
      attrs.class?.endsWith("EditText") === true;

    const text = (attrs.text ?? "").trim();
    const desc = (attrs["content-desc"] ?? "").trim();
    const rid = (attrs["resource-id"] ?? "").trim();
    const name = text || desc || rid.split("/").pop() || "";

    // A node with no label AND no interactivity cannot be acted on or referred
    // to, so it is pure token cost.
    if (!interactive && !name) continue;
    if (interactiveOnly && !interactive) continue;

    all.push({
      ref: `m${++seq}`,
      role: (attrs.class ?? "View").split(".").pop() || "View",
      name,
      ...(rid ? { resourceId: rid } : {}),
      clickable,
      editable,
      center: {
        x: Math.round((bounds.left + bounds.right) / 2),
        y: Math.round((bounds.top + bounds.bottom) / 2),
      },
      bounds,
    });
  }

  return { elements: all.slice(0, max), total: all.length };
}

/**
 * Render for the model, in the same shape `formatA11ySnapshot` uses so the two
 * screens read alike.
 *
 * Reports the REAL total when capped: "showing 120 of 210" tells the model
 * something is missing, where a bare 120 reads as the whole screen.
 */
export function formatUiHierarchy(
  parsed: { elements: MobileElement[]; total: number },
  device: { label: string; platform: string },
): string {
  const { elements, total } = parsed;
  if (elements.length === 0) {
    return (
      `No interactive elements on ${device.label}. The screen may still be loading, ` +
      `or the foreground app may draw its own surface (a game, a video, Flutter's ` +
      `default renderer) which uiautomator cannot see — use mode:"screenshot" for those.`
    );
  }
  const capped =
    total > elements.length
      ? ` (showing ${elements.length} of ${total} — the screen is dense; scroll or narrow by \`query\`)`
      : "";
  const lines = elements.map((e) => {
    const label = e.name ? ` "${e.name}"` : "";
    const rid = e.resourceId ? ` id=${e.resourceId.split("/").pop()}` : "";
    const kind = e.editable ? " [editable]" : e.clickable ? "" : " [readonly]";
    return `[${e.ref}] ${e.role}${label}${rid}${kind}`;
  });
  return (
    `${elements.length} element(s) on ${device.label} (${device.platform})${capped}. ` +
    `Act on any ref with mobile (e.g. action:"tap", ref:"m3"). Refs are valid for THIS screen only — ` +
    `re-read after anything that navigates.\n${lines.join("\n")}`
  );
}

/** Rank elements against a plain-words query, the way `browser`'s find does. */
export function findUiElements(
  elements: MobileElement[],
  query: string,
  max = 8,
): MobileElement[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const terms = q.split(/\s+/).filter(Boolean);
  const scored = elements.map((e) => {
    const hay = `${e.name} ${e.role} ${e.resourceId ?? ""}`.toLowerCase();
    let score = 0;
    if (hay.includes(q)) score += 50;
    for (const t of terms) if (hay.includes(t)) score += 10;
    if (e.name.toLowerCase() === q) score += 40;
    // The interactivity bonus is a TIE-BREAKER, applied only to something that
    // already matched. Adding it unconditionally gave every clickable element a
    // non-zero score, so a query matching nothing returned the whole screen as
    // "matches" — worse than an empty result, because the agent then acts on the
    // first one.
    if (score > 0 && (e.clickable || e.editable)) score += 5;
    return { e, score };
  });
  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, max)
    .map((s) => s.e);
}
