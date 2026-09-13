/**
 * Rendering an accessibility snapshot as the text a model reads.
 *
 * WHY THIS IS ITS OWN FILE. It used to live in `a11y-snapshot.ts`, which is the
 * ELECTRON transport — it types its first parameter as `Electron.WebContents`.
 * `packages/extension` compiles with `types: []` and no Electron at all, so
 * importing the formatter meant importing a module that cannot resolve there.
 * The extension would have grown a second renderer, and then the two surfaces
 * would describe the same page differently — which is the drift the whole
 * "one contract, two backends" arrangement exists to prevent.
 *
 * So this is the same split `page-scripts/` already made one level down: the
 * PAGE-realm code is shared, and now the text built from its result is too.
 * `a11y-snapshot.ts` re-exports both functions, so `browser.ts` and its tests
 * take zero diff.
 *
 * ZERO IMPORTS, deliberately — the same rule as `page-scripts/`, for a weaker
 * but real reason: an import that resolves on the desktop and not in a browser
 * bundle is exactly how this file would stop being shared.
 *
 * WHAT IT DOES NOT DO: wrap the result as untrusted data. Page text is
 * adversarial input and must be enveloped, but that belongs at the tool
 * boundary where the ORIGIN is known — `browser.ts` and the extension's
 * dispatcher each call `wrapUntrustedData` around what they get back. Doing it
 * here would double-wrap on one path and read as already-handled on the other.
 */

/** The one shape a formatted element can take. Kept minimal on purpose. */
interface FormattableElement {
  ref: string;
  role: string;
  name?: string;
  kind?: string;
  text?: string;
  placeholder?: string;
  value?: string;
}

interface FormattableSnapshot {
  count: number;
  total?: number;
  truncated?: boolean;
  filter?: string;
  viewport?: string;
  scrollY?: number;
  scrollMax?: number;
  elements: FormattableElement[];
}

interface FormattableFind {
  query: string;
  total?: number;
  truncated?: boolean;
  matches: Array<{ ref: string; role: string; name?: string }>;
}

/**
 * How the reading surface acts on a ref, in its own vocabulary.
 *
 * A PARAMETER RATHER THAN A CONSTANT because the two surfaces genuinely differ,
 * and the difference is not cosmetic. The desktop can click; the extension, as
 * of Phase 2, can only read. Telling an extension model to `action:"click"` on
 * a ref would be advertising a tool it has not been given — and a model that
 * tries it burns a round discovering the tool does not exist, every time.
 */
export interface A11yFormatOptions {
  /** Appended to the header. Empty string omits it. */
  actHint?: string;
  /** Appended when a find matched nothing. Empty string omits it. */
  emptyFindHint?: string;
}

/** The desktop's vocabulary, and the default so `a11y-snapshot.ts` is unchanged. */
const DESKTOP_ACT_HINT =
  ' Act on any ref with browser (e.g. action:"click", ref:"e3"). Refs are stable for this page.';
const DESKTOP_FIND_ACT_HINT =
  ' Act on a ref with browser (e.g. action:"click", ref).';
const DESKTOP_EMPTY_FIND_HINT =
  " Try fewer/different words, or read the page with browser_inspect.";

/** Render the snapshot as compact text the model reads (one line per element). */
export function formatSnapshot(
  snap: FormattableSnapshot,
  opts: A11yFormatOptions = {},
): string {
  const actHint = opts.actHint ?? DESKTOP_ACT_HINT;
  const lines = snap.elements.map((e) => {
    if (e.kind === "content") {
      return `[${e.ref}] ${e.role} — ${e.text ?? ""}`;
    }
    const bits = [`[${e.ref}] ${e.role}`];
    if (e.name) bits.push(`"${e.name}"`);
    if (e.placeholder) bits.push(`placeholder="${e.placeholder}"`);
    if (e.value) bits.push(`value="${e.value}"`);
    return bits.join(" ");
  });
  const combined = snap.filter === "all";
  const total = snap.total ?? snap.count;
  // Report the REAL total when capped — "capped at 200" told the model the cap,
  // not how much it was missing.
  const hasScroll = (snap.scrollMax ?? 0) > 0;
  const truncNote = snap.truncated
    ? ` (showing ${snap.count} of ${total} — narrow with a more specific query via browser({action:"find"})${hasScroll ? " or scroll down to trigger lazy-loaded content" : ""})`
    : "";
  const what = combined
    ? `${snap.count} element(s): page content + interactive controls`
    : `${snap.count} interactive element(s)`;
  const viewportNote = snap.viewport ? ` Rendered at ${snap.viewport}.` : "";
  let scrollNote = "";
  if (hasScroll) {
    const y = snap.scrollY ?? 0;
    const max = snap.scrollMax ?? 0;
    const atEnd = y >= max - 2;
    if (y <= 2)
      scrollNote = ` Scroll: top of page (0 of ${max}px — scroll down for more).`;
    else if (atEnd) scrollNote = ` Scroll: bottom reached (${y} of ${max}px).`;
    else
      scrollNote = ` Scroll: ${y} of ${max}px (midway — content above and below).`;
  }
  const header = `Page read — ${what}${truncNote}.${viewportNote}${scrollNote}${actHint}`;
  return `${header}\n${lines.join("\n")}`;
}

export function formatFind(
  res: FormattableFind,
  opts: A11yFormatOptions = {},
): string {
  const actHint = opts.actHint ?? DESKTOP_FIND_ACT_HINT;
  if (res.matches.length === 0) {
    const emptyHint = opts.emptyFindHint ?? DESKTOP_EMPTY_FIND_HINT;
    return `No elements matched "${res.query}".${emptyHint}`;
  }
  const lines = res.matches.map(
    (m) => `[${m.ref}] ${m.role}${m.name ? ` "${m.name}"` : ""}`,
  );
  const more = res.truncated
    ? ` More matches exist (${res.total} total) — narrow the query.`
    : "";
  return (
    `${res.matches.length} match(es) for "${res.query}", best first.${more}` +
    `${actHint}\n${lines.join("\n")}`
  );
}
