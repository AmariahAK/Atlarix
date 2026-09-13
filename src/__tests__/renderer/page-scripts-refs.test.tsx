/**
 * Ref round-trip, run against real DOM.
 *
 * THE CONTRACT THIS PINS. A read mints `data-atlarix-ref` values and the model
 * acts on them later, in a SEPARATE call: `browser({action:"click", ref:"e3"})`.
 * So a ref is only useful if minting and resolving agree — and after the
 * extraction to `lib/browser/page-scripts` those two halves are used by two
 * different backends (Electron `executeJavaScript` and, in the extension, a
 * content script). Both run these exact strings, so proving the round-trip here
 * proves it for both.
 *
 * Runs in the renderer (jsdom) project because these are page-realm scripts and
 * this is the only place with a real document.
 */

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { kernelCall, snapshotScript } from "@/lib/browser/page-scripts";

interface Snapshot {
  elements: Array<{ ref: string; role: string; name: string; kind?: string }>;
  count: number;
}

/** jsdom lays nothing out, so every rect is 0×0 and `isRendered` rejects all of
 *  it. Give elements a size so the walker sees the page a real browser would. */
const realRect = Element.prototype.getBoundingClientRect;
beforeEach(() => {
  document.body.innerHTML = "";
  Element.prototype.getBoundingClientRect = function () {
    return { width: 100, height: 20, top: 0, left: 0, right: 100, bottom: 20 };
  } as unknown as typeof realRect;
});
afterEach(() => {
  Element.prototype.getBoundingClientRect = realRect;
});

function read(filter: "all" | "interactive" = "interactive"): Snapshot {
  return new Function(`return ${snapshotScript(filter)}`)() as Snapshot;
}

/**
 * Resolve a ref exactly the way an action does.
 *
 * Through the kernel's `resolve` op since 2026-09-13 — `resolveElementJs` was a
 * second implementation of this and is gone. The kernel returns a DESCRIPTION
 * rather than a node (it has to: the extension's transport is structured clone,
 * which cannot carry an element), so the element is re-found here by the same
 * attribute the kernel matched on.
 */
function resolve(ref: string): Element | null {
  const ok = new Function(
    `return (${kernelCall({ op: "resolve", ref })}).ok`,
  )() as boolean;
  if (!ok) return null;
  return document.querySelector(`[data-atlarix-ref="${CSS.escape(ref)}"]`);
}

describe("ref round-trip", () => {
  it("resolves every minted ref back to the element it came from", () => {
    document.body.innerHTML = `
      <button id="save">Save</button>
      <input id="email" placeholder="Email" />
      <a id="help" href="/help">Help</a>`;
    const snap = read();
    expect(snap.count).toBeGreaterThanOrEqual(3);

    for (const el of snap.elements) {
      const node = resolve(el.ref);
      expect(node, `ref ${el.ref} did not resolve`).not.toBeNull();
      expect(node!.getAttribute("data-atlarix-ref")).toBe(el.ref);
    }
  });

  it("keeps a ref stable across two reads of the same document", () => {
    document.body.innerHTML = `<button id="save">Save</button>`;
    const first = read().elements[0].ref;
    const second = read().elements[0].ref;
    expect(second).toBe(first);
    expect(resolve(first)).toBe(document.getElementById("save"));
  });

  it("re-applies a ref a framework re-render stripped off", () => {
    document.body.innerHTML = `<button id="save">Save</button>`;
    const ref = read().elements[0].ref;

    // A re-render that keeps the node but wipes unknown attributes.
    document.getElementById("save")!.removeAttribute("data-atlarix-ref");
    expect(resolve(ref)).toBeNull();

    // The registry is a WeakMap on the element, so the next read restores it
    // rather than minting a second identity for the same button.
    expect(read().elements[0].ref).toBe(ref);
    expect(resolve(ref)).toBe(document.getElementById("save"));
  });

  it("mints a NEW ref when a re-render replaces the node", () => {
    document.body.innerHTML = `<button id="save">Save</button>`;
    const before = read().elements[0].ref;

    document.body.innerHTML = `<button id="save">Save</button>`;
    const after = read().elements[0].ref;

    expect(after).not.toBe(before);
    expect(resolve(before)).toBeNull();
  });

  it("does not resolve a ref that was never minted", () => {
    document.body.innerHTML = `<button>Save</button>`;
    expect(resolve("e9999")).toBeNull();
  });

  it("survives a hostile ref without throwing", () => {
    document.body.innerHTML = `<button>Save</button>`;
    expect(() => resolve(`"] , * , [x="`)).not.toThrow();
    expect(resolve(`"] , * , [x="`)).toBeNull();
  });
});
