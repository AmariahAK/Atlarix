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
 * The way to guarantee that is to share the CODE, not the plumbing. Everything
 * below runs in the page realm and touches nothing outside it. That is why this
 * file has **zero imports** and must keep it that way: an MV3 content script
 * cannot resolve `electron`, `node:*`, or anything that reaches for them
 * transitively.
 *
 * HOW IT REACHES THE PAGE, AND WHY THAT IS NOT COSMETIC
 * ----------------------------------------------------
 * This file used to say the extension would run "the identical bytes" of these
 * strings in a content script, and four other places repeated it. **That was
 * false, and it was the premise the whole design rested on.** MV3 cannot
 * execute a code string at all: `chrome.scripting.executeScript()` takes `func`
 * or `files` and has no `code` property, MV2's is gone, the extension CSP bars
 * `unsafe-eval`, and in `world: "MAIN"` an `eval()` runs under the PAGE's CSP —
 * which GitHub, Google and most banks block.
 *
 * So the sharing happens one level up. `atlarixPageKernel` is a real FUNCTION.
 * The extension hands it straight to `executeScript` with JSON-serializable
 * `args`; the desktop splices its `.toString()` into an `executeJavaScript`
 * string. One source, two transports, and the shapes cannot drift because there
 * is only one implementation.
 *
 * THE RULES THAT ARE NOT OPTIONAL
 * -------------------------------
 * 1. **No imports, ever.** Not even types from a module that itself imports.
 * 2. **Nothing inside the kernel may reference module scope.** A stringified
 *    function does not carry its module. This one is NEW — it did not matter
 *    while these were literal strings — and it is the easiest to break.
 * 3. **Model input reaches a script only through `jsonArg`.** A ref also goes
 *    through `CSS.escape`. There is no other interpolation path, and adding one
 *    would be an injection surface (the v12 3.5 trust boundary).
 * 4. **No backtick may appear in the kernel or in these template literals —
 *    including in a comment.** One silently terminates the literal, and that has
 *    broken the build twice. `browser-fill-target.test.ts` asserts this for the
 *    fillable snippet specifically.
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

/**
 * The result of an ACTION op (click / fill / hover-resolve / scroll).
 *
 * A FAILURE IS A VALUE, never a throw. The desktop learned this on Wikipedia's
 * search box: a ref pointing at a wrapper made the native value setter throw
 * "Illegal invocation", and the model — given an error that said nothing about
 * what to do — retried twice, tried a batch, and concluded the action system was
 * broken. Three turns for one wrapper element. Every `error` below therefore
 * names the next move, not just the fault.
 */
export interface PageActionResult {
  ok: boolean;
  error?: string;
  /** Lowercased tag of the element actually acted on — which may not be the one
   *  the ref pointed at, after the fillable walk. */
  tag?: string;
  /** A human-readable name for the confirmation line. */
  label?: string;
  /**
   * Where the element is, in viewport coordinates.
   *
   * `x`/`y` are the CENTRE, for input that must be dispatched at a point —
   * trusted pointer events have no other way to aim. `left`/`top` are the
   * box's corner, because the desktop draws a ring around the element and a
   * centre alone cannot describe a rectangle.
   */
  rect?: {
    x: number;
    y: number;
    left: number;
    top: number;
    width: number;
    height: number;
  };
  /**
   * What the element IS, for the caller's own safety classifier.
   *
   * Read in the page because it is the only place these attributes exist, and
   * returned rather than judged here: the kernel runs inside a hostile document
   * and must not be the thing deciding whether an action is dangerous. It
   * reports; the extension decides, out of the page's reach.
   */
  target?: {
    tag?: string;
    type?: string;
    autocomplete?: string;
    name?: string;
    id?: string;
    ariaLabel?: string;
    placeholder?: string;
    text?: string;
    /** `autocomplete` of the OTHER fields in this element's form. A submit
     *  button carries no payment hint of its own; the form around it does. */
    formAutocomplete?: string[];
  };
  /** After a scroll, so the caller can say whether anything moved. */
  scrollY?: number;
  scrollMax?: number;
  /** The page's URL at the moment the op finished. */
  url?: string;
}

/** Max elements per read — keeps the payload small on huge pages. */
export const MAX_ELEMENTS = 200;
/** The combined read carries content too, so it gets a larger budget. */
export const MAX_ELEMENTS_ALL = 400;
/** Max matches returned by action:"find" before asking for a narrower query. */
export const MAX_FIND_MATCHES = 20;

/** What the kernel is being asked to do. Must be JSON-serializable: the
 *  extension passes it through `chrome.scripting.executeScript`'s `args`, which
 *  is structured clone. */
export type PageRequest =
  | { op: "snapshot"; filter: A11yFilter; max: number }
  | { op: "find"; query: string; max: number }
  /** Locate an element and report where it is. The prerequisite for any input
   *  that must be aimed at a POINT — a trusted pointer event cannot take a node. */
  | { op: "resolve"; ref?: string; selector?: string }
  | { op: "click"; ref?: string; selector?: string }
  | { op: "fill"; ref?: string; selector?: string; value: string | boolean }
  | {
      op: "scroll";
      direction: "up" | "down" | "top" | "bottom";
      /** Pixels for up/down. Defaults to about one viewport. */
      amount?: number;
    };

/**
 * THE function that runs in the page realm. Both backends execute this exact
 * source; nothing else in this file reaches a page.
 *
 * IT IS A FUNCTION, NOT A STRING, AND THAT IS FORCED BY MV3.
 * `chrome.scripting.executeScript()` accepts `func` or `files` and has no
 * `code` property — MV2's is gone. `eval` is barred by the extension CSP, and
 * in `world: "MAIN"` it runs under the PAGE's CSP, which GitHub, Google and
 * most banks block. So there is no route that executes a string in an
 * extension. Chrome serializes this function with `Function.prototype.toString`
 * and calls it with JSON-serializable `args`; the desktop composes the same
 * source into an `executeJavaScript` string. One source, two transports.
 *
 * THREE RULES, ALL ENFORCED BY TEST — see `page-scripts-portable.test.ts` and
 * `renderer/page-scripts-injectable.test.tsx`:
 *
 * 1. **No reference to anything outside this function.** A stringified function
 *    does not carry its module, so `MAX_ELEMENTS` would be a ReferenceError in
 *    the page. Caps arrive as `req.max`. This rule is NEW — it did not exist
 *    while these scripts were literal strings, and it is the one most likely to
 *    be broken by a well-meaning edit.
 * 2. **No backtick anywhere, including in a comment.** This source is spliced
 *    into template literals in `browser.ts`, and one backtick silently
 *    terminates the literal. It has broken the build twice.
 * 3. **No TypeScript feature that needs an emit helper** — no `enum`, no
 *    `namespace`, no decorators, no class fields. Those compile to a reference
 *    to a module-scope helper, which is rule 1 again by another route. The
 *    build pins `target: es2022` and `keepNames: false` for the same reason:
 *    downlevelled async and esbuild's `__name()` both inject one.
 */
export function atlarixPageKernel(
  req: PageRequest,
): A11ySnapshot | A11yFindResult | PageActionResult {
  // The ref registry lives on the page's own window: a WeakMap keyed on DOM
  // nodes cannot be held by the main process, and is equally out of reach of a
  // service worker. It is also why the extension must inject with
  // world: "MAIN" — an isolated world would hand every read a fresh, empty one.
  const w = window as unknown as {
    __atlarixRefs?: WeakMap<Element, string>;
    __atlarixRefSeq?: number;
  };
  if (!w.__atlarixRefs) {
    w.__atlarixRefs = new WeakMap();
    w.__atlarixRefSeq = 0;
  }
  const REFS = w.__atlarixRefs;

  const refOf = (el: Element): string => {
    let r = REFS.get(el);
    if (!r) {
      w.__atlarixRefSeq = (w.__atlarixRefSeq ?? 0) + 1;
      r = "e" + w.__atlarixRefSeq;
      REFS.set(el, r);
    }
    // Re-apply if a framework re-render stripped the attribute.
    if (el.getAttribute("data-atlarix-ref") !== r) {
      try {
        el.setAttribute("data-atlarix-ref", r);
      } catch {
        /* read-only node */
      }
    }
    return r;
  };

  const CONTROL_SELECTOR = [
    "a[href]",
    "button",
    "input",
    "select",
    "textarea",
    "summary",
    "[role]",
    "[onclick]",
    '[contenteditable="true"]',
    '[tabindex]:not([tabindex="-1"])',
  ].join(",");

  const isRendered = (el: Element): boolean => {
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return false;
    const style = window.getComputedStyle(el);
    if (style.visibility === "hidden" || style.display === "none") return false;
    return true;
  };

  const ownText = (el: Element): string => {
    let t = "";
    for (const n of el.childNodes) {
      if (n.nodeType === 3 && n.textContent) t += n.textContent;
    }
    return t.replace(/\s+/g, " ").trim();
  };

  /**
   * The accessible name, in roughly the order the W3C accname algorithm uses.
   *
   * THE IMAGE FALLBACKS ARE NOT OPTIONAL, and their absence was found on real
   * pages rather than in a test. An icon-only link — a logo, a toolbar button,
   * a close X — has no aria-label, no title and no own text, so it read as a
   * bare "a" with an empty name. The model can still click it, because a ref
   * does not depend on a name, but it cannot tell the user what it is about to
   * click or choose between two of them. Icon-only controls are everywhere.
   *
   * aria-labelledby comes first because the spec puts it first, and because
   * it is what component libraries emit for a button labelled by a sibling.
   */
  const accName = (el: Element): string => {
    const labelledBy = el.getAttribute("aria-labelledby");
    if (labelledBy) {
      const text = labelledBy
        .split(/\s+/)
        .map((id) => {
          try {
            return document.getElementById(id)?.textContent ?? "";
          } catch {
            return "";
          }
        })
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();
      if (text) return text;
    }

    const raw =
      el.getAttribute("aria-label") ||
      el.getAttribute("title") ||
      (el as HTMLElement).innerText ||
      // The element's OWN alt, then a contained image's. A bare <img> and an
      // <a> wrapping one are both common, and the second is the case that
      // produced nameless rows on real sites.
      el.getAttribute("alt") ||
      el.querySelector("img[alt]")?.getAttribute("alt") ||
      el.getAttribute("placeholder") ||
      el.getAttribute("name") ||
      // A submit button's label lives in its value attribute, not its text.
      (el.tagName === "INPUT" ? el.getAttribute("value") : "") ||
      "";
    return String(raw).replace(/\s+/g, " ").trim();
  };

  const roleOf = (el: Element): string =>
    el.getAttribute("role") || el.tagName.toLowerCase();

  // ── Actions ───────────────────────────────────────────────────────────────
  //
  // SYNCHRONOUS, DELIBERATELY. Making any branch async makes the WHOLE kernel
  // async, which would turn every snapshot into a promise and change what both
  // transports receive. Waiting for a page to settle is the caller's job and
  // both callers already do it: the extension has waitForLoad, and so does the
  // desktop. (No backtick in this comment: rule 2 above, caught by test.)
  if (req.op === "resolve" || req.op === "click" || req.op === "fill") {
    // Resolution order is REF FIRST, then CSS selector. A ref is something we
    // minted and is stable across re-renders; a selector is the model's guess.
    // Both reach the DOM only inside a string literal, and the ref goes through
    // CSS.escape, so neither is an injection surface.
    let el: Element | null = null;
    const wantRef = String(req.ref || "");
    const wantSel = String(req.selector || "");
    if (wantRef) {
      try {
        el = document.querySelector(
          '[data-atlarix-ref="' + CSS.escape(wantRef) + '"]',
        );
      } catch {
        /* fall through to the selector */
      }
    }
    if (!el && wantSel) {
      try {
        el = document.querySelector(wantSel);
      } catch {
        /* an invalid selector is reported below, not thrown */
      }
    }
    if (!el) {
      return {
        ok: false,
        error:
          "No element matched " +
          (wantRef ? 'ref "' + wantRef + '"' : "") +
          (wantRef && wantSel ? " or " : "") +
          (wantSel ? 'selector "' + wantSel + '"' : "") +
          ". Refs are invalidated when a page reloads or navigates — read the page again and use a fresh one.",
        url: location.href,
      };
    }

    const describe = (node: Element): string => {
      let label = "";
      try {
        const labels = (node as HTMLInputElement).labels;
        label =
          (labels && labels[0] && labels[0].innerText) ||
          node.getAttribute("aria-label") ||
          node.getAttribute("placeholder") ||
          node.getAttribute("name") ||
          accName(node) ||
          "";
      } catch {
        label = "";
      }
      return String(label).replace(/\s+/g, " ").trim().slice(0, 80);
    };

    // Everything the caller's classifier needs, gathered in one place so click
    // and fill cannot describe the same element differently.
    const targetOf = (node: Element) => {
      const form = node.closest("form");
      const formAutocomplete: string[] = [];
      if (form) {
        for (const field of form.querySelectorAll("[autocomplete]")) {
          const value = field.getAttribute("autocomplete");
          if (value) formAutocomplete.push(value);
        }
      }
      return {
        tag: node.tagName.toLowerCase(),
        type: node.getAttribute("type") || undefined,
        autocomplete: node.getAttribute("autocomplete") || undefined,
        name: node.getAttribute("name") || undefined,
        id: node.id || undefined,
        ariaLabel: node.getAttribute("aria-label") || undefined,
        placeholder: node.getAttribute("placeholder") || undefined,
        text: accName(node).slice(0, 120),
        formAutocomplete: formAutocomplete.slice(0, 40),
      };
    };

    const boxOf = (node: Element) => {
      const r = node.getBoundingClientRect();
      return {
        // The CENTRE, so a pointer aimed here lands inside the element even if
        // it has padding or a border the caller knows nothing about.
        x: Math.round(r.left + r.width / 2),
        y: Math.round(r.top + r.height / 2),
        left: Math.round(r.left),
        top: Math.round(r.top),
        width: Math.round(r.width),
        height: Math.round(r.height),
      };
    };

    if (req.op === "resolve") {
      // Bring it into view FIRST: the rect is in viewport coordinates, so a
      // rect measured before scrolling would aim a pointer at where the element
      // used to be.
      try {
        el.scrollIntoView({ block: "center" });
      } catch {
        /* an element in a detached subtree cannot scroll; the rect still reads */
      }
      return {
        ok: true,
        tag: el.tagName.toLowerCase(),
        label: describe(el),
        rect: boxOf(el),
        target: targetOf(el),
        url: location.href,
      };
    }

    if (req.op === "click") {
      try {
        el.scrollIntoView({ block: "center" });
      } catch {
        /* not fatal */
      }
      const label = describe(el) || accName(el);
      (el as HTMLElement).click();
      return {
        ok: true,
        tag: el.tagName.toLowerCase(),
        label: String(label).slice(0, 120),
        url: location.href,
      };
    }

    // ── fill ────────────────────────────────────────────────────────────────
    //
    // THE WRAPPER WALK, and it is here because of a real page. A ref can point
    // at a WRAPPER rather than the field: the snapshot calls it "search input"
    // because that is its accessible ROLE, while the node is a div or a form
    // with the real input inside. Modern component libraries do this constantly.
    const FILLABLE =
      "input:not([type=hidden]),textarea,select,[contenteditable=true],[contenteditable='']";
    if (!el.matches(FILLABLE)) {
      const inner = el.querySelector(FILLABLE);
      const outer = el.closest(FILLABLE);
      if (inner) el = inner;
      else if (outer) el = outer;
      else {
        return {
          ok: false,
          tag: el.tagName.toLowerCase(),
          error:
            "<" +
            el.tagName.toLowerCase() +
            "> is not a field and contains none" +
            (el.getAttribute("role")
              ? ' (role="' + el.getAttribute("role") + '")'
              : "") +
            ". It may be a wrapper that reveals the real input when clicked: click this ref, read the page again, then fill the field that appears.",
          url: location.href,
        };
      }
    }

    try {
      el.scrollIntoView({ block: "center" });
    } catch {
      /* not fatal */
    }
    (el as HTMLElement).focus();

    const raw = req.value;
    const value = typeof raw === "string" ? raw : String(raw);
    const fire = (node: Element, name: string) => {
      node.dispatchEvent(new Event(name, { bubbles: true }));
    };

    if (
      el instanceof HTMLInputElement &&
      (el.type === "checkbox" || el.type === "radio")
    ) {
      const want =
        typeof raw === "boolean"
          ? raw
          : !/^(false|0|off|no|unchecked)$/i.test(value);
      if (el.checked !== want) el.click();
      fire(el, "input");
      fire(el, "change");
    } else if (el instanceof HTMLSelectElement) {
      // Match on VALUE first, then on visible TEXT. A value-vs-label mismatch is
      // the commonest reason a select fill silently does nothing at all.
      const opts = Array.from(el.options);
      const norm = (v: unknown) =>
        String(v == null ? "" : v)
          .trim()
          .toLowerCase();
      const opt =
        opts.find((o) => o.value === value) ||
        opts.find((o) => norm(o.text) === norm(value)) ||
        opts.find((o) => norm(o.text).indexOf(norm(value)) !== -1);
      if (!opt) {
        return {
          ok: false,
          tag: "select",
          error:
            'No option matched "' +
            value +
            '" (options: ' +
            opts
              .slice(0, 12)
              .map((o) => o.text.trim())
              .join(" | ") +
            ")",
          url: location.href,
        };
      }
      el.value = opt.value;
      fire(el, "input");
      fire(el, "change");
    } else if (
      // The PROPERTY and the ATTRIBUTE, because they disagree in cases that
      // matter. `isContentEditable` is computed from rendering, so it reads
      // false for an element that is detached or inside a hidden subtree even
      // when the author explicitly set the attribute — and false here falls
      // through to the native value setter, which throws on a div. (It is also
      // simply absent in jsdom, which is how this was noticed.)
      (el as HTMLElement).isContentEditable ||
      el.getAttribute("contenteditable") === "" ||
      el.getAttribute("contenteditable") === "true"
    ) {
      // A rich-text editor has no value property at all, and the native setter
      // throws when handed one.
      (el as HTMLElement).textContent = value;
      fire(el, "input");
    } else {
      // Pick the prototype from what the node IS, never by elimination. A native
      // accessor REJECTS a receiver of the wrong type, so a wrong guess throws
      // "Illegal invocation" instead of degrading — which is the error that cost
      // three turns on Wikipedia. A null proto means no native setter applies
      // and the plain assignment below is correct.
      const proto =
        el instanceof HTMLTextAreaElement
          ? HTMLTextAreaElement.prototype
          : el instanceof HTMLInputElement
            ? HTMLInputElement.prototype
            : null;
      const setter = proto
        ? Object.getOwnPropertyDescriptor(proto, "value")?.set
        : null;
      if (setter) setter.call(el, value);
      else (el as HTMLInputElement).value = value;
      fire(el, "input");
      fire(el, "change");
    }

    return {
      ok: true,
      tag: el.tagName.toLowerCase(),
      label: describe(el),
      rect: boxOf(el),
      target: targetOf(el),
      url: location.href,
    };
  }

  if (req.op === "scroll") {
    const doc = document.scrollingElement || document.documentElement;
    const page = Math.max(1, window.innerHeight - 100);
    const step =
      typeof req.amount === "number" && req.amount > 0 ? req.amount : page;
    if (req.direction === "top") window.scrollTo(0, 0);
    else if (req.direction === "bottom") window.scrollTo(0, doc.scrollHeight);
    else window.scrollBy(0, req.direction === "up" ? -step : step);
    return {
      ok: true,
      scrollY: Math.round(doc.scrollTop),
      scrollMax: Math.max(0, Math.round(doc.scrollHeight - window.innerHeight)),
      url: location.href,
    };
  }

  if (req.op === "snapshot") {
    const WANT_CONTENT = req.filter === "all";
    const MAX = req.max;
    const out: A11yElement[] = [];
    let total = 0;
    let truncated = false;
    // One document-order pass so controls and content interleave the way the
    // page actually reads, rather than two separately-ordered lists.
    for (const el of document.querySelectorAll("body *")) {
      try {
        const isControl = el.matches(CONTROL_SELECTOR);
        const text = WANT_CONTENT ? ownText(el) : "";
        const isContent = WANT_CONTENT && text.length > 0;
        if (!isControl && !isContent) continue;
        if (!isRendered(el)) continue;
        total++;
        if (out.length >= MAX) {
          truncated = true;
          continue;
        }
        const ref = refOf(el);
        if (isControl) {
          const item: A11yElement = {
            ref,
            role: roleOf(el),
            name: accName(el).slice(0, 80),
            kind: "control",
          };
          const val = (el as HTMLInputElement).value;
          if (typeof val === "string" && val) item.value = val.slice(0, 60);
          const ph = el.getAttribute("placeholder");
          if (ph) item.placeholder = ph.slice(0, 60);
          out.push(item);
        } else {
          out.push({
            ref,
            role: el.tagName.toLowerCase(),
            name: "",
            text: text.slice(0, 200),
            kind: "content",
          });
        }
      } catch {
        /* skip element */
      }
    }
    return {
      url: location.href,
      title: document.title,
      count: out.length,
      total,
      truncated,
      elements: out,
      viewport: window.innerWidth + "x" + window.innerHeight,
      scrollY: Math.round(window.scrollY),
      scrollMax: Math.round(
        document.documentElement.scrollHeight - window.innerHeight,
      ),
      filter: req.filter,
    };
  }

  // op === "find" — natural-language element lookup, ranked HEURISTICALLY in the
  // page: deterministic, free, instant, and no LLM call.
  const Q = String(req.query).toLowerCase().trim();
  const MAX = req.max;
  const tokens = Q.split(/\s+/).filter(Boolean);
  // Role words in the query ("button", "link", "field") should bias the role
  // match rather than being searched for inside the element's own text.
  const ROLE_WORDS: Record<string, string[]> = {
    button: ["button"],
    link: ["a", "link"],
    field: ["input", "textarea"],
    input: ["input", "textarea"],
    box: ["input", "textarea"],
    textbox: ["input", "textarea"],
    checkbox: ["input"],
    dropdown: ["select"],
    select: ["select"],
    menu: ["select", "nav"],
    heading: ["h1", "h2", "h3", "h4", "h5", "h6"],
    image: ["img"],
    icon: ["svg", "img"],
  };
  const scored: Array<{
    el: Element;
    ref: string;
    role: string;
    name: string;
    score: number;
    kind: "control" | "content";
  }> = [];
  for (const el of document.querySelectorAll("body *")) {
    try {
      const isControl = el.matches(CONTROL_SELECTOR);
      const text = ownText(el);
      if (!isControl && !text) continue;
      if (!isRendered(el)) continue;
      const role = roleOf(el);
      const name = (accName(el) || text).slice(0, 120);
      const hay = (name + " " + role).toLowerCase();
      let score = 0;
      if (hay === Q || name.toLowerCase() === Q) score += 100;
      else if (name.toLowerCase().startsWith(Q)) score += 60;
      else if (hay.indexOf(Q) !== -1) score += 40;
      for (const t of tokens) {
        const roles = ROLE_WORDS[t];
        if (roles) {
          if (roles.indexOf(role) !== -1) score += 25;
          continue;
        }
        if (hay.indexOf(t) !== -1) score += 12;
      }
      if (score <= 0) continue;
      // Prefer actionable elements, and shorter names (a nav wrapper containing
      // "Sign in" should lose to the actual "Sign in" button).
      if (isControl) score += 15;
      score -= Math.min(10, Math.floor(name.length / 20));
      scored.push({
        el,
        ref: "",
        role,
        name,
        score,
        kind: isControl ? "control" : "content",
      });
    } catch {
      /* skip */
    }
  }
  scored.sort((a, b) => b.score - a.score);
  const top = scored.slice(0, MAX);
  // Only mint refs for what we actually return — no need to tag the whole page.
  for (const m of top) m.ref = refOf(m.el);
  return {
    url: location.href,
    title: document.title,
    query: String(req.query),
    total: scored.length,
    truncated: scored.length > MAX,
    matches: top.map((m) => ({
      ref: m.ref,
      role: m.role,
      name: m.name,
      score: m.score,
      kind: m.kind,
    })),
    viewport: window.innerWidth + "x" + window.innerHeight,
  };
}

/**
 * The kernel's own source, computed once. This is what gets spliced into the
 * desktop's `executeJavaScript` strings.
 */
const KERNEL_SRC = atlarixPageKernel.toString();

/**
 * The ONLY way model input reaches a script.
 *
 * `<` is escaped because this source can end up inside an HTML context, and
 * `undefined` becomes `null` because `JSON.stringify(undefined)` returns the
 * VALUE undefined, not a string — which would splice the bare word `undefined`
 * into the script.
 */
function jsonArg(value: unknown): string {
  return JSON.stringify(value === undefined ? null : value).replace(
    /</g,
    "\\u003c",
  );
}
/**
 * One kernel call, as source text, for splicing into a desktop script.
 *
 * THE ONE WAY THE DESKTOP REACHES AN OP. `browser.ts` composes bigger scripts
 * around these — pre-state capture, the AI cursor the user watches, the settle
 * and delta report — and all of that is genuinely desktop-only. What must NOT be
 * desktop-only is the resolution and the mutation, which is why they are in the
 * kernel and this is the only door to them.
 *
 * The request goes through `jsonArg`, so model input reaches the page exactly
 * the way it does for a read: inside a JSON literal, never concatenated.
 */
export function kernelCall(req: PageRequest): string {
  return `(${KERNEL_SRC})(${jsonArg(req)})`;
}

/** The in-page walker. The kernel carries the logic; `filter` and the cap are
 *  the only things that vary, and they arrive as JSON. */
export function snapshotScript(filter: A11yFilter): string {
  const max = filter === "all" ? MAX_ELEMENTS_ALL : MAX_ELEMENTS;
  return `(${KERNEL_SRC})(${jsonArg({ op: "snapshot", filter, max })})`;
}

/**
 * action:"find" — natural-language element lookup, ranked HEURISTICALLY in the
 * page (deterministic, free, instant — no LLM call). Scores each candidate on
 * role + accessible name + text against the query's tokens.
 */
export function findScript(query: string): string {
  return `(${KERNEL_SRC})(${jsonArg({ op: "find", query: String(query), max: MAX_FIND_MATCHES })})`;
}

/**
 * WHAT USED TO BE HERE: `resolveElementJs` and `RESOLVE_FILLABLE_JS`, two
 * strings the desktop spliced into its own action scripts.
 *
 * DELETED 2026-09-13, because they were a second implementation of what the
 * kernel now does — and the second one held all the hard-won parts: the fillable
 * WRAPPER walk (Wikipedia's Vector search box), matching a select on visible
 * text before its value, choosing the native setter by what the node IS rather
 * than by elimination. Two copies of that is exactly one copy too many: a fix
 * applied to one would leave the other quietly wrong, on the backend nobody was
 * looking at.
 *
 * The desktop now reaches every op through `kernelCall` above and wraps it with
 * the parts that really are desktop-only — the cursor the user watches and the
 * delta report.
 */
