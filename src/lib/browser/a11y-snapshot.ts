/**
 * Accessibility snapshot of the in-app browser page — the `agent-browser`
 * technique on Electron's WebContentsView.
 *
 * An injected DOM walker tags elements with a `data-atlarix-ref` ("e1", "e2", …)
 * and returns a compact list. The model reads this (far lighter than a
 * screenshot or full DOM) and acts via `browser({ action, ref })`,
 * resolving the ref by attribute instead of a brittle CSS selector.
 *
 * REFS ARE STABLE PER ELEMENT (v14.16): the ref registry is a `WeakMap` living
 * in the PAGE realm (`window.__atlarixRefs`), keyed on the element itself, so a
 * ref means the same element for the life of the document. It has to live in
 * the page — a WeakMap keyed on DOM nodes can't be held in the main process —
 * which also means it resets naturally on navigation (a new document is a new
 * JS realm). Previously refs were assigned by walk order on EVERY read, so
 * inserting a node near the top silently shifted every later ref and a click
 * could land on the wrong element.
 *
 * A framework re-render that REPLACES a node correctly mints a new ref (it is a
 * different element); one that merely re-renders in place keeps its ref. If the
 * framework strips the attribute, the walker re-applies it from the WeakMap.
 *
 * `filter:"all"` (the default read) returns interactive elements AND
 * text-bearing content in one pass, so reading a page to act on it is one call.
 * `filter:"interactive"` reproduces the interactive-only listing.
 *
 * Runs through the same `executeJavaScript(script, true)` channel as the other
 * browser tools. Model input reaches the script ONLY via JSON.stringify.
 */

export type A11yFilter = "all" | "interactive";

export interface A11yElement {
  ref: string;
  role: string;
  name: string;
  value?: string;
  placeholder?: string;
  /** Present on content nodes (filter:"all"): the element's own visible text. */
  text?: string;
  /** "control" = actionable, "content" = text-bearing. */
  kind?: "control" | "content";
}

export interface A11ySnapshot {
  url: string;
  title: string;
  count: number;
  truncated: boolean;
  elements: A11yElement[];
  /** Total candidates found before capping (honest truncation reporting). */
  total?: number;
  /** Layout viewport the page was measured at, e.g. "1280x800". */
  viewport?: string;
  /** Current vertical scroll offset in pixels. */
  scrollY?: number;
  /** Maximum scrollable distance (scrollHeight − viewportHeight). ≤0 means the page fits in one screen. */
  scrollMax?: number;
  filter?: A11yFilter;
}

export interface A11yFindMatch {
  ref: string;
  role: string;
  name: string;
  score: number;
  kind?: "control" | "content";
}

export interface A11yFindResult {
  url: string;
  title: string;
  query: string;
  total: number;
  truncated: boolean;
  matches: A11yFindMatch[];
  viewport?: string;
}

/** Max elements per read — keeps the payload small on huge pages. */
const MAX_ELEMENTS = 200;
/** The combined read carries content too, so it gets a larger budget. */
const MAX_ELEMENTS_ALL = 400;
/** Max matches returned by action:"find" before asking for a narrower query. */
const MAX_FIND_MATCHES = 20;

/**
 * Shared in-page preamble: the stable ref registry plus the element predicates.
 * Static template — no interpolation of model input.
 */
const WALKER_PREAMBLE = `
  if (!window.__atlarixRefs) { window.__atlarixRefs = new WeakMap(); window.__atlarixRefSeq = 0; }
  const REFS = window.__atlarixRefs;
  const refOf = (el) => {
    let r = REFS.get(el);
    if (!r) {
      r = 'e' + (++window.__atlarixRefSeq);
      REFS.set(el, r);
    }
    // Re-apply if a framework re-render stripped the attribute.
    if (el.getAttribute('data-atlarix-ref') !== r) {
      try { el.setAttribute('data-atlarix-ref', r); } catch (e) {}
    }
    return r;
  };
  const CONTROL_SELECTOR = [
    'a[href]','button','input','select','textarea','summary',
    '[role]','[onclick]','[contenteditable="true"]','[tabindex]:not([tabindex="-1"])'
  ].join(',');
  const isRendered = (el) => {
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return false;
    const style = window.getComputedStyle(el);
    if (style.visibility === 'hidden' || style.display === 'none') return false;
    return true;
  };
  const ownText = (el) => {
    let t = '';
    for (const n of el.childNodes) {
      if (n.nodeType === 3 && n.textContent) t += n.textContent;
    }
    return t.replace(/\\s+/g, ' ').trim();
  };
  const accName = (el) => {
    const raw = el.getAttribute('aria-label') || el.getAttribute('title')
      || (el.innerText || '') || el.getAttribute('placeholder')
      || el.getAttribute('name') || '';
    return String(raw).replace(/\\s+/g, ' ').trim();
  };
  const roleOf = (el) => el.getAttribute('role') || el.tagName.toLowerCase();
`;

/** The in-page walker. `filter` and caps are numeric/string literals only. */
function snapshotScript(filter: A11yFilter): string {
  const max = filter === "all" ? MAX_ELEMENTS_ALL : MAX_ELEMENTS;
  return `(() => {
  ${WALKER_PREAMBLE}
  const WANT_CONTENT = ${JSON.stringify(filter)} === 'all';
  const MAX = ${max};
  const out = [];
  let total = 0;
  let truncated = false;
  // One document-order pass so controls and content interleave the way the page
  // actually reads, rather than two separately-ordered lists.
  const walk = document.querySelectorAll('body *');
  for (const el of walk) {
    try {
      const isControl = el.matches(CONTROL_SELECTOR);
      const text = WANT_CONTENT ? ownText(el) : '';
      const isContent = WANT_CONTENT && text.length > 0;
      if (!isControl && !isContent) continue;
      if (!isRendered(el)) continue;
      total++;
      if (out.length >= MAX) { truncated = true; continue; }
      const ref = refOf(el);
      if (isControl) {
        const item = { ref, role: roleOf(el), name: accName(el).slice(0, 80), kind: 'control' };
        const val = el.value;
        if (typeof val === 'string' && val) item.value = val.slice(0, 60);
        const ph = el.getAttribute('placeholder');
        if (ph) item.placeholder = ph.slice(0, 60);
        out.push(item);
      } else {
        out.push({ ref, role: el.tagName.toLowerCase(), name: '', text: text.slice(0, 200), kind: 'content' });
      }
    } catch (e) { /* skip element */ }
  }
  return {
    url: location.href,
    title: document.title,
    count: out.length,
    total,
    truncated,
    elements: out,
    viewport: window.innerWidth + 'x' + window.innerHeight,
    scrollY: Math.round(window.scrollY),
    scrollMax: Math.round(document.documentElement.scrollHeight - window.innerHeight),
    filter: ${JSON.stringify(filter)},
  };
})()`;
}

/** Run the walker in a page; null on failure. */
export async function getA11ySnapshot(
  wc: Electron.WebContents,
  filter: A11yFilter = "interactive",
): Promise<A11ySnapshot | null> {
  try {
    const result = (await wc.executeJavaScript(
      snapshotScript(filter),
      true,
    )) as A11ySnapshot | null;
    if (!result || !Array.isArray(result.elements)) return null;
    return result;
  } catch {
    return null;
  }
}

/** Render the snapshot as compact text the model reads (one line per element). */
export function formatA11ySnapshot(snap: A11ySnapshot): string {
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
    const max = snap.scrollMax!;
    const atEnd = y >= max - 2;
    if (y <= 2)
      scrollNote = ` Scroll: top of page (0 of ${max}px — scroll down for more).`;
    else if (atEnd) scrollNote = ` Scroll: bottom reached (${y} of ${max}px).`;
    else
      scrollNote = ` Scroll: ${y} of ${max}px (midway — content above and below).`;
  }
  const header =
    `Page read — ${what}${truncNote}.${viewportNote}${scrollNote}` +
    ` Act on any ref with browser (e.g. action:"click", ref:"e3"). Refs are stable for this page.`;
  return `${header}\n${lines.join("\n")}`;
}

/**
 * action:"find" — natural-language element lookup, ranked HEURISTICALLY in the
 * page (deterministic, free, instant — no LLM call). Scores each candidate on
 * role + accessible name + text against the query's tokens.
 */
function findScript(query: string): string {
  return `(() => {
  ${WALKER_PREAMBLE}
  const Q = ${JSON.stringify(String(query))}.toLowerCase().trim();
  const MAX = ${MAX_FIND_MATCHES};
  const tokens = Q.split(/\\s+/).filter(Boolean);
  // Role words in the query ("button", "link", "field") should bias the role
  // match rather than being searched for inside the element's own text.
  const ROLE_WORDS = {
    button: ['button'], link: ['a','link'], field: ['input','textarea'],
    input: ['input','textarea'], box: ['input','textarea'], textbox: ['input','textarea'],
    checkbox: ['input'], dropdown: ['select'], select: ['select'], menu: ['select','nav'],
    heading: ['h1','h2','h3','h4','h5','h6'], image: ['img'], icon: ['svg','img'],
  };
  const scored = [];
  for (const el of document.querySelectorAll('body *')) {
    try {
      const isControl = el.matches(CONTROL_SELECTOR);
      const text = ownText(el);
      if (!isControl && !text) continue;
      if (!isRendered(el)) continue;
      const role = roleOf(el);
      const name = (accName(el) || text).slice(0, 120);
      const hay = (name + ' ' + role).toLowerCase();
      let score = 0;
      if (hay === Q || name.toLowerCase() === Q) score += 100;
      else if (name.toLowerCase().startsWith(Q)) score += 60;
      else if (hay.indexOf(Q) !== -1) score += 40;
      for (const t of tokens) {
        const roles = ROLE_WORDS[t];
        if (roles) { if (roles.indexOf(role) !== -1) score += 25; continue; }
        if (hay.indexOf(t) !== -1) score += 12;
      }
      if (score <= 0) continue;
      // Prefer actionable elements, and shorter names (a nav wrapper containing
      // "Sign in" should lose to the actual "Sign in" button).
      if (isControl) score += 15;
      score -= Math.min(10, Math.floor(name.length / 20));
      scored.push({ el, ref: null, role, name, score, kind: isControl ? 'control' : 'content' });
    } catch (e) { /* skip */ }
  }
  scored.sort((a, b) => b.score - a.score);
  const top = scored.slice(0, MAX);
  // Only mint refs for what we actually return — no need to tag the whole page.
  for (const m of top) m.ref = refOf(m.el);
  return {
    url: location.href,
    title: document.title,
    query: ${JSON.stringify(String(query))},
    total: scored.length,
    truncated: scored.length > MAX,
    matches: top.map((m) => ({ ref: m.ref, role: m.role, name: m.name, score: m.score, kind: m.kind })),
    viewport: window.innerWidth + 'x' + window.innerHeight,
  };
})()`;
}

export async function findA11yElements(
  wc: Electron.WebContents,
  query: string,
): Promise<A11yFindResult | null> {
  try {
    const result = (await wc.executeJavaScript(
      findScript(query),
      true,
    )) as A11yFindResult | null;
    if (!result || !Array.isArray(result.matches)) return null;
    return result;
  } catch {
    return null;
  }
}

export function formatA11yFind(res: A11yFindResult): string {
  if (res.matches.length === 0) {
    return `No elements matched "${res.query}". Try fewer/different words, or read the page with browser_inspect.`;
  }
  const lines = res.matches.map(
    (m) => `[${m.ref}] ${m.role}${m.name ? ` "${m.name}"` : ""}`,
  );
  const more = res.truncated
    ? ` More matches exist (${res.total} total) — narrow the query.`
    : "";
  return (
    `${res.matches.length} match(es) for "${res.query}", best first.${more}` +
    ` Act on a ref with browser (e.g. action:"click", ref).\n${lines.join("\n")}`
  );
}
