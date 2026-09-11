/**
 * Page-realm scripts shared by EVERY Atlarix browser backend.
 *
 * WHY THIS MODULE EXISTS
 * ----------------------
 * Atlarix drives two different browsers: the in-app Electron `WebContentsView`
 * (via `executeJavaScript`) and the user's own Chrome through the MV3 extension
 * (via `chrome.scripting.executeScript` in a content script). The model is shown
 * ONE tool contract — `browser` / `browser_inspect` with a `target` — and that
 * promise only holds if both backends return byte-identical shapes.
 *
 * The way to guarantee that is to share the SCRIPTS, not the plumbing. Everything
 * below is a plain string (or a function returning one) that runs in the page
 * realm and touches nothing outside it. That is why this file has **zero
 * imports** and must keep it that way: an MV3 content script cannot resolve
 * `electron`, `node:*`, or anything that reaches for them transitively.
 *
 * THE RULES THAT ARE NOT OPTIONAL
 * -------------------------------
 * 1. **No imports, ever.** Not even types from a module that itself imports.
 * 2. **Model input reaches a script only through `JSON.stringify`.** A ref also
 *    goes through `CSS.escape`. There is no other interpolation path, and adding
 *    one would be an injection surface (the v12 3.5 trust boundary).
 * 3. **No backtick may appear inside these template literals — including in a
 *    comment.** One silently terminates the literal, and that has broken the
 *    build twice. `browser-fill-target.test.ts` asserts this for the fillable
 *    snippet specifically.
 *
 * Refs are stable per element: the registry is a `WeakMap` in the PAGE realm
 * (`window.__atlarixRefs`) keyed on the element, so a ref means the same element
 * for the life of the document and resets naturally on navigation (a new
 * document is a new JS realm). It HAS to live in the page — a WeakMap keyed on
 * DOM nodes cannot be held by the main process, and it is equally out of reach
 * of a service worker.
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
export const MAX_ELEMENTS = 200;
/** The combined read carries content too, so it gets a larger budget. */
export const MAX_ELEMENTS_ALL = 400;
/** Max matches returned by action:"find" before asking for a narrower query. */
export const MAX_FIND_MATCHES = 20;

/**
 * Shared in-page preamble: the stable ref registry plus the element predicates.
 * Static template — no interpolation of model input.
 */
export const WALKER_PREAMBLE = `
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
export function snapshotScript(filter: A11yFilter): string {
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

/**
 * action:"find" — natural-language element lookup, ranked HEURISTICALLY in the
 * page (deterministic, free, instant — no LLM call). Scores each candidate on
 * role + accessible name + text against the query's tokens.
 */
export function findScript(query: string): string {
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

/**
 * In-page JS that declares `el` by resolving a browser_inspect snapshot `ref`
 * (data-atlarix-ref) first, then a CSS `selector`. Both inputs are embedded only
 * inside string literals (JSON.stringify) and the ref goes through CSS.escape —
 * no injection surface (v12 3.5 trust boundary).
 */
export function resolveElementJs(ref?: string, selector?: string): string {
  return `const __ref = ${JSON.stringify(String(ref ?? ""))};
      const __sel = ${JSON.stringify(String(selector ?? ""))};
      let el = null;
      if (__ref) { try { el = document.querySelector('[data-atlarix-ref="' + CSS.escape(__ref) + '"]'); } catch (e) {} }
      if (!el && __sel) { try { el = document.querySelector(__sel); } catch (e) {} }`;
}

/**
 * In-page: walk from the resolved element to the field it actually contains.
 *
 * OBSERVED BUG (Wikipedia's Vector search box, 2026-09-02). A ref can point at a
 * WRAPPER rather than the field. The accessibility snapshot labels it "search
 * input" because that is its accessible ROLE, but the node is a div/form and the
 * real input is inside it — modern component libraries do this constantly.
 *
 * The old code went straight to `HTMLInputElement.prototype`'s value setter for
 * anything that was not a textarea. A native accessor REJECTS a receiver of the
 * wrong type, so that threw "Illegal invocation" — an error that tells the model
 * nothing about what to do instead. In the observed run it retried the same call
 * twice, tried a click-then-fill batch, concluded the whole action system was
 * broken, and worked around it. Three wasted turns for a wrapper element.
 *
 * Kept as a named snippet rather than inlined so `browser-fill-target.test.ts`
 * can run it against real DOM in jsdom. The in-page scripts are template
 * literals, so this must contain NO BACKTICK — one in a comment silently ends
 * the literal, which has now broken the build twice.
 */
export const RESOLVE_FILLABLE_JS = `const __fillable = "input:not([type=hidden]),textarea,select,[contenteditable=true],[contenteditable=\\"\\"]";
      if (!el.matches(__fillable)) {
        const inner = el.querySelector(__fillable);
        const outer = el.closest(__fillable);
        if (inner) el = inner;
        else if (outer) el = outer;
        else {
          return {
            ok: false,
            error: "<" + el.tagName.toLowerCase() + "> is not a field and contains none"
              + (el.getAttribute("role") ? ' (role="' + el.getAttribute("role") + '")' : "")
              + ". It may be a wrapper that reveals the real input when clicked: try"
              + ' action:"click" on this ref, then re-read the page and fill the field that appears.',
          };
        }
      }`;
