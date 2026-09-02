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
 * Runs in the renderer (jsdom) project because the snippet is page-realm
 * JavaScript and this is the only place with a real document.
 */

import { describe, expect, it, beforeEach } from "vitest";
import { RESOLVE_FILLABLE_JS } from "@/lib/tools/browser";

/** Run the snippet against `el`, returning either the resolved node or the error. */
function resolveFillTarget(
  el: Element,
): { ok: true; node: Element } | { ok: false; error: string } {
  const fn = new Function(
    "el",
    `${RESOLVE_FILLABLE_JS}\nreturn { ok: true, node: el };`,
  ) as (e: Element) => { ok: true; node: Element } | { ok: false; error: string };
  return fn(el);
}

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("fill target resolution", () => {
  it("returns a real input unchanged", () => {
    document.body.innerHTML = `<input id="q" type="search" />`;
    const r = resolveFillTarget(document.getElementById("q")!);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.node.id).toBe("q");
  });

  it("walks INTO a wrapper — the Wikipedia Vector shape", () => {
    // A div carrying the searchbox role, with the field nested inside it.
    document.body.innerHTML = `
      <div id="wrap" role="search">
        <form><input id="real" type="search" name="search" /></form>
      </div>`;
    const r = resolveFillTarget(document.getElementById("wrap")!);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.node.id).toBe("real");
  });

  it("walks OUT to an ancestor field when the ref landed on inner chrome", () => {
    // The mirror case: a ref on a decorative span inside the input's label.
    document.body.innerHTML = `<textarea id="ta"></textarea>`;
    const ta = document.getElementById("ta")!;
    const r = resolveFillTarget(ta);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.node.tagName).toBe("TEXTAREA");
  });

  it("prefers a contained field over an ancestor one", () => {
    // Both directions available: the field the user pointed INTO is the intent.
    document.body.innerHTML = `
      <form><input id="outer" /><div id="wrap"><input id="inner" /></div></form>`;
    const r = resolveFillTarget(document.getElementById("wrap")!);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.node.id).toBe("inner");
  });

  it("finds a contenteditable, which has no value property at all", () => {
    document.body.innerHTML = `<div id="wrap"><div id="rt" contenteditable="true"></div></div>`;
    const r = resolveFillTarget(document.getElementById("wrap")!);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.node.id).toBe("rt");
  });

  it("ignores a hidden input, which a fill cannot usefully target", () => {
    document.body.innerHTML = `<div id="wrap"><input type="hidden" name="token" /></div>`;
    const r = resolveFillTarget(document.getElementById("wrap")!);
    expect(r.ok).toBe(false);
  });

  it("fails with an ACTIONABLE error naming the tag and the role", () => {
    // The whole point: not "Illegal invocation". The model has to learn what the
    // element is and what to do next.
    document.body.innerHTML = `<div id="wrap" role="combobox">Search</div>`;
    const r = resolveFillTarget(document.getElementById("wrap")!);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).not.toMatch(/illegal invocation/i);
      expect(r.error).toContain("<div>");
      expect(r.error).toContain('role="combobox"');
      // And it names the recovery that actually worked in the observed run.
      expect(r.error).toContain('action:"click"');
    }
  });

  it("the snippet contains no backtick", () => {
    // It is interpolated into a template literal. A backtick — even inside a
    // comment — silently ends that literal. This has broken the build twice.
    expect(RESOLVE_FILLABLE_JS).not.toContain("`");
  });
});
