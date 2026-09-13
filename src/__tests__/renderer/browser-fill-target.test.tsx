/**
 * The fill target walk — run against real DOM.
 *
 * THE BUG THIS PINS. A `ref` can point at a WRAPPER, not the field: the
 * accessibility snapshot labels Wikipedia's Vector search "search input" because
 * that is its ROLE, while the node is a div and the input is inside it. The fill
 * handler chose its native value setter by elimination (`textarea ? … :
 * HTMLInputElement.prototype`), and a native accessor rejects a receiver of the
 * wrong type — so it threw **"Illegal invocation"**, which told the model
 * nothing. Observed 2026-09-02: it retried twice, tried a click-then-fill batch,
 * concluded the action system was broken, and worked around it.
 *
 * MOVED TO THE KERNEL 2026-09-13. This used to exercise `RESOLVE_FILLABLE_JS`, a
 * string the desktop spliced into its own fill script while the extension
 * carried a second copy of the same logic. There is now one implementation, so
 * these cases are asserted against the thing both backends actually run — and
 * they run it the way both backends do, as detached source in global scope.
 *
 * Runs in the renderer (jsdom) project because this is page-realm JavaScript and
 * this is the only place with a real document.
 */

import { describe, expect, it, beforeEach } from "vitest";
import {
  atlarixPageKernel,
  type PageActionResult,
  type PageRequest,
} from "@/lib/browser/page-scripts";

const KERNEL = atlarixPageKernel.toString();
const MARKER = "__filled__";

/**
 * Fill via `selector` and report which node actually received the value.
 *
 * Asking "where did the text land" rather than "what did it resolve to" is the
 * stronger question: it is what the user sees, and it cannot pass while the
 * value quietly goes somewhere else.
 */
function fillVia(
  selector: string,
): { ok: true; node: Element } | { ok: false; error: string } {
  const req: PageRequest = { op: "fill", selector, value: MARKER };
  const result = new Function(
    `return (${KERNEL})(${JSON.stringify(req)})`,
  )() as PageActionResult;

  if (!result.ok) return { ok: false, error: result.error ?? "" };

  const filled =
    Array.from(
      document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(
        "input,textarea",
      ),
    ).find((el) => el.value === MARKER) ??
    Array.from(document.querySelectorAll("[contenteditable]")).find(
      (el) => el.textContent === MARKER,
    );

  if (!filled)
    return { ok: false, error: "reported ok but nothing was filled" };
  return { ok: true, node: filled };
}

beforeEach(() => {
  document.body.innerHTML = "";
  // Every action path calls it, and jsdom does not implement it.
  Element.prototype.scrollIntoView = function () {};
});

describe("fill target resolution", () => {
  it("returns a real input unchanged", () => {
    document.body.innerHTML = `<input id="q" type="search" />`;
    const r = fillVia("#q");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.node.id).toBe("q");
  });

  it("walks INTO a wrapper — the Wikipedia Vector shape", () => {
    // A div carrying the searchbox role, with the field nested inside it.
    document.body.innerHTML = `
      <div id="wrap" role="search">
        <form><input id="real" type="search" name="search" /></form>
      </div>`;
    const r = fillVia("#wrap");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.node.id).toBe("real");
  });

  it("walks OUT to an ancestor field when the ref landed on inner chrome", () => {
    // `closest`, not a sibling search: a ref on a node INSIDE the editable
    // region should fill the region. Guessing at siblings is how an agent fills
    // the wrong box on a form with six of them.
    document.body.innerHTML = `<div id="rt" contenteditable="true"><span id="inner">old</span></div>`;
    const r = fillVia("#inner");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.node.id).toBe("rt");
  });

  it("prefers a contained field over an ancestor one", () => {
    // Both directions available: the field the user pointed INTO is the intent.
    document.body.innerHTML = `
      <form><input id="outer" /><div id="wrap"><input id="inner" /></div></form>`;
    const r = fillVia("#wrap");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.node.id).toBe("inner");
  });

  it("finds a contenteditable, which has no value property at all", () => {
    document.body.innerHTML = `<div id="wrap"><div id="rt" contenteditable="true"></div></div>`;
    const r = fillVia("#wrap");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.node.id).toBe("rt");
  });

  it("ignores a hidden input, which a fill cannot usefully target", () => {
    document.body.innerHTML = `<div id="wrap"><input type="hidden" name="token" /></div>`;
    expect(fillVia("#wrap").ok).toBe(false);
  });

  it("fails with an ACTIONABLE error naming the tag and the role", () => {
    // The whole point: not "Illegal invocation". The model has to learn what the
    // element is and what to do next.
    document.body.innerHTML = `<div id="wrap" role="combobox">Search</div>`;
    const r = fillVia("#wrap");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).not.toMatch(/illegal invocation/i);
      expect(r.error).toContain("<div>");
      expect(r.error).toContain('role="combobox"');
      // And it names the recovery that actually worked in the observed run.
      // Worded without a tool name now that two surfaces share it: the desktop
      // spells it `browser({action:"click"})` and the extension spells it
      // `click`, so the shared message names the MOVE and not the call.
      expect(r.error).toContain("click this ref");
      expect(r.error).toContain("read the page again");
    }
  });

  it("the kernel contains no backtick", () => {
    // It is interpolated into template literals in `browser.ts`. A backtick —
    // even inside a comment — silently ends that literal. It has broken the
    // build three times.
    expect(KERNEL).not.toContain("`");
  });
});
