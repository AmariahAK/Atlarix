/**
 * The page-realm scripts the DESKTOP runs for each action, as pure functions.
 *
 * WHY THEY MOVED OUT OF `browser.ts`. They were built inline, inside handlers
 * that need an Electron `WebContentsView` — so the only way to see the text was
 * to run the app, and the only way a syntax error announced itself was a broken
 * action at runtime. Three of this repo's recorded traps are exactly that shape
 * (a backtick in a comment ending a template literal, twice). As pure functions
 * of their arguments, the text can be built and PARSED in a test.
 *
 * WHAT IS AND IS NOT HERE. The resolution, the mutation and the AI CURSOR are
 * NOT: they live in `page-scripts/index.ts` and are reached through
 * `kernelCall`, because the extension runs the same code and a second copy is
 * how the two drift. The cursor moved there on 2026-09-13 for exactly that
 * reason — the desktop drew it and the extension did not, so a page in the
 * user's own browser filled itself in silence.
 *
 * What is left here is the before/after delta the desktop tool reports, the
 * pause that lets the cursor be SEEN before the action lands, and the two
 * label-only chips for actions that have no element to point at.
 *
 * NO BACKTICK ANYWHERE in the emitted strings, for the same reason the kernel
 * bans them: these are template literals containing template literals.
 */

import {
  AI_CURSOR_DURATION_MS,
  AI_CURSOR_LABEL_JS,
  AI_CURSOR_WAIT_MS,
} from "./ai-cursor";
import { kernelCall } from "./page-scripts";

/** Snapshot the page before an action, so the delta below has something to compare. */
export const CAPTURE_PRE_STATE_JS = `const __pre = {
      url: location.href,
      count: document.querySelectorAll('body *').length,
      textLen: ((document.body && document.body.innerText) || '').length,
    };`;

/** Settle briefly, then compute `__delta` against `__pre`. */
export const SETTLE_AND_DELTA_JS = `await new Promise(function (r) { setTimeout(r, 200); });
      const __postCount = document.querySelectorAll('body *').length;
      const __postTextLen = ((document.body && document.body.innerText) || '').length;
      const __delta = {
        urlChanged: location.href !== __pre.url,
        newUrl: location.href !== __pre.url ? location.href : undefined,
        elementDelta: __postCount - __pre.count,
        textChanged: Math.abs(__postTextLen - __pre.textLen) > 20,
        cls: typeof window.__atlarixCLS === 'number' ? window.__atlarixCLS : null,
      };`;

interface Target {
  ref?: string;
  selector?: string;
}

/** Wait for the cursor animation to be seen before the action lands. */
const CURSOR_PAUSE_JS = `await new Promise(function (r) { setTimeout(r, ${AI_CURSOR_WAIT_MS}); });`;

export function clickScript(target: Target): string {
  return `(async () => {
      ${CAPTURE_PRE_STATE_JS}
      const __t = ${kernelCall({ op: "resolve", ...target, cursor: "click" })};
      if (!__t.ok) return __t;
      ${CURSOR_PAUSE_JS}
      const __a = ${kernelCall({ op: "click", ...target })};
      if (!__a.ok) return __a;
      ${SETTLE_AND_DELTA_JS}
      return { ok: true, tag: __a.tag, text: (__a.label || "").slice(0, 120), delta: __delta };
    })()`;
}

export function fillScript(target: Target, value: string | boolean): string {
  return `(async () => {
      ${CAPTURE_PRE_STATE_JS}
      const __t = ${kernelCall({ op: "resolve", ...target, cursor: "type" })};
      if (!__t.ok) return __t;
      ${CURSOR_PAUSE_JS}
      const __a = ${kernelCall({ op: "fill", ...target, value })};
      if (!__a.ok) return __a;
      ${SETTLE_AND_DELTA_JS}
      return { ok: true, tag: __a.tag, label: __a.label, delta: __delta };
    })()`;
}

/**
 * Point at the target and focus it, before a key is sent from the main process.
 *
 * Focusing has no kernel op and needs none: it is not a page MUTATION and
 * carries none of the lessons the fill path does. The element is re-found by the
 * same attribute the kernel matched, because the kernel returns a DESCRIPTION
 * rather than a node — it has to, since the extension's transport is structured
 * clone and cannot carry an element.
 */
export function focusForKeyScript(target: Target, label: string): string {
  return `(() => {
        const __t = ${kernelCall({ op: "resolve", ...target, cursor: label })};
        if (!__t.ok) return false;
        try {
          const __el = document.querySelector('[data-atlarix-ref="' + CSS.escape(${JSON.stringify(String(target.ref ?? ""))}) + '"]')
            || document.querySelector(${JSON.stringify(String(target.selector || "*:not(*)"))});
          if (__el) __el.focus();
        } catch (e) {}
        return true;
      })()`;
}

/** Show the key chip when there is no element to point at. */
export function keyChipScript(label: string): string {
  return `(() => { ${AI_CURSOR_LABEL_JS(label, AI_CURSOR_DURATION_MS)} return true; })()`;
}

/** Locate a hover target: the kernel already returns the centre point and a label. */
export function hoverScript(target: Target): string {
  return `(() => {
      const __t = ${kernelCall({ op: "resolve", ...target, cursor: "hover" })};
      if (!__t.ok) return null;
      return { x: __t.rect.x, y: __t.rect.y, tag: __t.tag, name: __t.label || "" };
    })()`;
}

/**
 * Bring one element into view.
 *
 * `resolve` scrolls as part of its contract — the rect it returns is in VIEWPORT
 * coordinates, so it has no choice.
 */
export function scrollToScript(target: Target): string {
  return `(() => ${kernelCall({ op: "resolve", ...target })}.ok)()`;
}

/**
 * Scroll the page itself.
 *
 * A kernel `scroll` op DOES exist (`page-scripts/index.ts`) and the extension
 * uses it — this comment used to say there was none, which stopped being true
 * when the op was added. The desktop keeps its own builder for two things the
 * kernel op does not do: horizontal scrolling (left/right), and drawing the AI
 * cursor label so the user can see the page being driven.
 */
export function scrollByScript(direction: string, amount: number): string {
  return `(() => {
        ${AI_CURSOR_LABEL_JS(`scroll ${direction}`, AI_CURSOR_DURATION_MS)}
        const dir = ${JSON.stringify(direction)};
        const amt = ${JSON.stringify(amount)};
        const step = amt > 0 ? amt : Math.round(window.innerHeight * 0.9);
        const dx = dir === 'left' ? -step : dir === 'right' ? step : 0;
        const dy = dir === 'up' ? -step : dir === 'down' ? step : 0;
        window.scrollBy(dx, dy);
        return true;
      })()`;
}

/** Every builder, for a test that must not miss one when a sixth is added. */
export const ACTION_SCRIPT_BUILDERS = {
  click: () => clickScript({ ref: "e1" }),
  fill: () => fillScript({ ref: "e1" }, "value"),
  focusForKey: () => focusForKeyScript({ ref: "e1" }, "Enter"),
  keyChip: () => keyChipScript("Enter"),
  hover: () => hoverScript({ ref: "e1" }),
  scrollTo: () => scrollToScript({ ref: "e1" }),
  scrollBy: () => scrollByScript("down", 0),
} as const;
