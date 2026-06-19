/**
 * Accessibility snapshot of the in-app browser page — the `agent-browser`
 * technique on Electron's WebContentsView.
 *
 * An injected DOM walker tags every interactive/landmark element with a stable
 * `data-atlarix-ref` ("e1", "e2", …) and returns a compact `{ ref, role, name }`
 * list. The model reads this (far lighter than a screenshot or full DOM) and
 * acts via `browser_interact({ action, ref })`, resolving the ref by attribute
 * instead of a brittle CSS selector. Re-run per page; refs reset on navigation.
 *
 * Runs through the same `executeJavaScript(script, true)` channel as the other
 * browser tools — the script is a static template (no model input interpolated),
 * so it carries no injection surface.
 */

export interface A11yElement {
  ref: string;
  role: string;
  name: string;
  value?: string;
  placeholder?: string;
}

export interface A11ySnapshot {
  url: string;
  title: string;
  count: number;
  truncated: boolean;
  elements: A11yElement[];
}

/** Max elements per snapshot — keeps the payload small on huge pages. */
const MAX_ELEMENTS = 200;

/** The in-page walker. Static template — no interpolation of model input. */
const SNAPSHOT_SCRIPT = `(() => {
  const SELECTOR = [
    'a[href]','button','input','select','textarea','summary',
    '[role]','[onclick]','[contenteditable="true"]','[tabindex]:not([tabindex="-1"])'
  ].join(',');
  const MAX = ${MAX_ELEMENTS};
  const els = Array.from(document.querySelectorAll(SELECTOR));
  const out = [];
  let n = 0;
  let truncated = false;
  for (const el of els) {
    try {
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) continue; // not rendered
      const style = window.getComputedStyle(el);
      if (style.visibility === 'hidden' || style.display === 'none') continue;
      if (n >= MAX) { truncated = true; break; }
      n++;
      const ref = 'e' + n;
      el.setAttribute('data-atlarix-ref', ref);
      const role = el.getAttribute('role') || el.tagName.toLowerCase();
      const rawName = el.getAttribute('aria-label') || el.getAttribute('title')
        || (el.innerText || '') || el.getAttribute('placeholder') || el.getAttribute('name') || '';
      const name = String(rawName).replace(/\\s+/g, ' ').trim().slice(0, 80);
      const item = { ref, role, name };
      const val = el.value;
      if (typeof val === 'string' && val) item.value = val.slice(0, 60);
      const ph = el.getAttribute('placeholder');
      if (ph) item.placeholder = ph.slice(0, 60);
      out.push(item);
    } catch (e) { /* skip element */ }
  }
  return { url: location.href, title: document.title, count: out.length, truncated, elements: out };
})()`;

/** Run the walker in the active page; null on failure. */
export async function getA11ySnapshot(
  wc: Electron.WebContents,
): Promise<A11ySnapshot | null> {
  try {
    const result = (await wc.executeJavaScript(SNAPSHOT_SCRIPT, true)) as
      | A11ySnapshot
      | null;
    if (!result || !Array.isArray(result.elements)) return null;
    return result;
  } catch {
    return null;
  }
}

/** Render the snapshot as compact text the model reads (one line per element). */
export function formatA11ySnapshot(snap: A11ySnapshot): string {
  const lines = snap.elements.map((e) => {
    const bits = [`[${e.ref}] ${e.role}`];
    if (e.name) bits.push(`"${e.name}"`);
    if (e.placeholder) bits.push(`placeholder="${e.placeholder}"`);
    if (e.value) bits.push(`value="${e.value}"`);
    return bits.join(" ");
  });
  const header = `Accessibility snapshot — ${snap.count} interactive element(s)${snap.truncated ? ` (capped at ${MAX_ELEMENTS})` : ""}. Act on these with browser_interact (action:"click"|"fill") using the ref (e.g. ref:"e3").`;
  return `${header}\n${lines.join("\n")}`;
}
