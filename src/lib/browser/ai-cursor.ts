/**
 * The on-screen AI pointer for the in-app browser.
 *
 * The agent driving a page is invisible unless we draw it. This renders a
 * PERSISTENT cursor (it stays put between actions rather than flashing for
 * 600ms and vanishing) that glides to each target, plus a ring around the
 * target and a chip naming the action — so `hover`, `key` and `scroll`, which
 * have no visible effect of their own, can actually be watched.
 *
 * Kept free of Electron imports so it can be exercised directly against a real
 * page in a test harness, like a11y-snapshot.ts.
 */

/** How long the ring/chip stay on screen, and how long to wait before acting. */
export const AI_CURSOR_DURATION_MS = 600;
export const AI_CURSOR_WAIT_MS = 240;

/**
 * The visible AI pointer. A PERSISTENT cursor (it doesn't vanish between
 * actions) that glides to each target, so the user can watch what the agent is
 * doing rather than catching a 600ms flash. Every action also flashes a ring
 * around its target and a small chip naming the action ("click", "Enter",
 * "hover") — otherwise key/hover/scroll are completely invisible on screen.
 *
 * Overlay is `pointer-events:none` (never intercepts the real action), lives in
 * one singleton container, uses only transform/opacity, and is entirely wrapped
 * in try/catch (best-effort; CSP-tolerant). It is torn down naturally by
 * navigation. `label` is embedded via JSON.stringify — no injection surface.
 */
export const AI_CURSOR_SETUP_JS = `
    var __id = "__atlarix_ai_cursor__";
    var __c = document.getElementById(__id);
    if (!__c) {
      __c = document.createElement("div"); __c.id = __id;
      __c.style.cssText = "position:fixed;left:0;top:0;width:0;height:0;pointer-events:none;z-index:2147483647;";
      var __p = document.createElement("div"); __p.setAttribute("data-part", "pointer");
      // Arrow-shaped pointer so it reads as a cursor, not a dot.
      __p.style.cssText = "position:fixed;left:0;top:0;width:18px;height:18px;margin:-2px 0 0 -2px;"
        + "background:#34d399;opacity:0;pointer-events:none;"
        + "clip-path:polygon(0 0, 0 78%, 26% 60%, 44% 100%, 62% 90%, 46% 52%, 78% 46%);"
        + "filter:drop-shadow(0 1px 3px rgba(0,0,0,.45));"
        + "transition:transform .32s cubic-bezier(.22,.61,.36,1),opacity .2s ease;";
      var __g = document.createElement("div"); __g.setAttribute("data-part", "ring");
      __g.style.cssText = "position:fixed;box-sizing:border-box;border:2px solid #34d399;border-radius:6px;"
        + "box-shadow:0 0 0 4px rgba(52,211,153,.22);opacity:0;transition:opacity .18s ease;pointer-events:none;";
      var __b = document.createElement("div"); __b.setAttribute("data-part", "chip");
      __b.style.cssText = "position:fixed;padding:2px 7px;border-radius:999px;background:rgba(6,78,59,.92);"
        + "color:#d1fae5;font:600 11px/1.4 ui-sans-serif,system-ui,sans-serif;white-space:nowrap;opacity:0;"
        + "transition:opacity .18s ease,transform .32s cubic-bezier(.22,.61,.36,1);pointer-events:none;";
      __c.appendChild(__g); __c.appendChild(__p); __c.appendChild(__b);
      document.body.appendChild(__c);
    }
    var __ptr = __c.querySelector('[data-part="pointer"]');
    var __ring = __c.querySelector('[data-part="ring"]');
    var __chip = __c.querySelector('[data-part="chip"]');`;

/**
 * WHAT USED TO BE HERE: `AI_CURSOR_AT_ELEMENT_JS`, then `AI_CURSOR_AT_RECT_JS`.
 *
 * The pointer-at-a-target drawing MOVED INTO THE SHARED KERNEL on 2026-09-13
 * (`page-scripts/index.ts`, the `cursor` option on `resolve`). The desktop drew
 * it and the extension did not, so a page in the user's own browser filled
 * itself in silence — and "the form filled itself" is alarming in a way that "I
 * watched it get filled" is not. One implementation, both surfaces.
 *
 * What remains here is the SETUP (shared by the label-only chip below) and the
 * chip itself, for the actions that have no element to point at: a key press
 * with no target, and a page scroll.
 */

/**
 * Show a labelled chip without a target element — for actions that have no
 * element to point at (a key press with no ref, a page scroll).
 */
export function AI_CURSOR_LABEL_JS(label: string, durationMs: number): string {
  const fade = Math.max(0, durationMs - 150);
  return `try {
    ${AI_CURSOR_SETUP_JS}
    __chip.textContent = ${JSON.stringify(String(label))};
    if (!__chip.style.transform) {
      __chip.style.transform = "translate(" + (window.innerWidth / 2) + "px,24px)";
    }
    __chip.style.opacity = "1";
    setTimeout(function () { try { __chip.style.opacity = "0"; } catch (e) {} }, ${fade});
  } catch (e) {}`;
}
