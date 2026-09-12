/**
 * The kernel must survive being stringified — which is the only way either
 * backend runs it.
 *
 * `page-scripts-refs.test.tsx` proves the ref round-trip against real DOM. This
 * file proves the thing that test cannot: that the kernel works when it is
 * detached from its module, because that is what actually happens.
 * `chrome.scripting.executeScript({ func })` serializes it with
 * `Function.prototype.toString` and evaluates the text in the page; the desktop
 * splices the same text into `executeJavaScript`. Neither carries the module, so
 * a single surviving reference to module scope is a ReferenceError in the page —
 * on whichever branch touches it, which may not be the common one.
 *
 * Every call below therefore evaluates the kernel in GLOBAL scope, where the
 * module's bindings do not exist. A test that imported and called it directly
 * would pass while the real thing was broken.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  MAX_ELEMENTS,
  MAX_FIND_MATCHES,
  atlarixPageKernel,
  findScript,
  snapshotScript,
  type A11yFindResult,
  type A11ySnapshot,
  type PageRequest,
} from "@/lib/browser/page-scripts";

/**
 * Evaluate the kernel the way a backend does: as source text, in global scope,
 * with a JSON-serializable argument. No closure over anything.
 */
function inject<T>(source: string, req: PageRequest): T {
  return new Function(
    `return (${source})(${JSON.stringify(req)})`,
  )() as unknown as T;
}

/** jsdom lays nothing out, so every rect is 0x0 and `isRendered` rejects all of
 *  it. Give elements a size so the kernel sees the page a real browser would. */
const realRect = Element.prototype.getBoundingClientRect;
beforeEach(() => {
  document.body.innerHTML = "";
  Element.prototype.getBoundingClientRect = function () {
    return { width: 100, height: 20, top: 0, left: 0, right: 100, bottom: 20 };
  } as unknown as typeof realRect;
});
afterEach(() => {
  Element.prototype.getBoundingClientRect = realRect;
  delete (window as unknown as Record<string, unknown>).__atlarixRefs;
  delete (window as unknown as Record<string, unknown>).__atlarixRefSeq;
});

const KERNEL = atlarixPageKernel.toString();

describe("the kernel survives detachment from its module", () => {
  /**
   * NOTE FOR ANYONE ADDING A CASE HERE: **jsdom does not implement
   * `innerText`** — it is `undefined`, not the text. `accName` reads
   * `aria-label` → `title` → `innerText` → `placeholder` → `name`, so a snapshot
   * `name` in this environment must come from an attribute. A fixture written
   * as plain child text yields `name: ""` and looks like a ranking bug that does
   * not exist in a real browser. (`find` is unaffected: it falls back to
   * `ownText`, which uses `textContent`, which jsdom does implement.)
   */
  it("runs in global scope on the snapshot branch", () => {
    document.body.innerHTML = `<button aria-label="Sign in">Sign in</button><a href="/x" aria-label="Docs">Docs</a>`;
    const snap = inject<A11ySnapshot>(KERNEL, {
      op: "snapshot",
      filter: "interactive",
      max: MAX_ELEMENTS,
    });
    expect(snap.elements).toHaveLength(2);
    expect(snap.elements[0]).toMatchObject({ role: "button", name: "Sign in" });
    expect(snap.filter).toBe("interactive");
  });

  it("runs in global scope on the FIND branch too", () => {
    // The branch a runtime test most easily misses: `find` is the second
    // consumer of the shared helpers, so it is where a helper fix applied to
    // only one path would show up.
    document.body.innerHTML = `<button>Save draft</button><button>Submit</button>`;
    const found = inject<A11yFindResult>(KERNEL, {
      op: "find",
      query: "submit",
      max: MAX_FIND_MATCHES,
    });
    expect(found.matches[0]?.name).toBe("Submit");
    expect(found.query).toBe("submit");
  });
});

describe("a ref minted by one call resolves in a later, SEPARATE one", () => {
  it("is the whole contract, and it holds across two evaluations", () => {
    // This is what the model actually does: read, then act on a ref in a later
    // turn. The two calls share nothing but the page's own window.
    document.body.innerHTML = `<button id="target">Delete</button>`;
    const snap = inject<A11ySnapshot>(KERNEL, {
      op: "snapshot",
      filter: "interactive",
      max: MAX_ELEMENTS,
    });
    const ref = snap.elements[0].ref;
    expect(ref).toMatch(/^e\d+$/);

    const resolved = new Function(
      `return document.querySelector('[data-atlarix-ref="' + ${JSON.stringify(ref)} + '"]')`,
    )() as HTMLElement | null;
    expect(resolved?.id).toBe("target");
  });

  it("gives the same element the same ref on a re-read", () => {
    document.body.innerHTML = `<button>One</button><button>Two</button>`;
    const first = inject<A11ySnapshot>(KERNEL, {
      op: "snapshot",
      filter: "interactive",
      max: MAX_ELEMENTS,
    });
    const second = inject<A11ySnapshot>(KERNEL, {
      op: "snapshot",
      filter: "interactive",
      max: MAX_ELEMENTS,
    });
    expect(second.elements.map((e) => e.ref)).toEqual(
      first.elements.map((e) => e.ref),
    );
  });
});

describe("the composed desktop strings are the same code", () => {
  it("snapshotScript evaluates to the same result as a direct injection", () => {
    document.body.innerHTML = `<button aria-label="Go">Go</button>`;
    const viaComposer = new Function(
      `return ${snapshotScript("interactive")}`,
    )() as A11ySnapshot;
    expect(viaComposer.elements[0]).toMatchObject({ name: "Go" });
    expect(viaComposer.filter).toBe("interactive");
  });

  it("findScript carries the query and cannot break out of its literal", () => {
    document.body.innerHTML = `<button>Ship it</button>`;
    const hostile = '"); alert(1); //';
    const script = findScript(hostile);
    // It must still be valid, evaluable source — the point of jsonArg.
    const result = new Function(`return ${script}`)() as A11yFindResult;
    expect(result.query).toBe(hostile);
  });
});

describe("caps travel as arguments", () => {
  it("truncates at the cap it was GIVEN, and reports the real total", () => {
    // Previously pinned only by the string literal `const MAX = 200;`, which the
    // composer no longer emits. The behaviour is what matters.
    document.body.innerHTML = Array.from(
      { length: 12 },
      (_, i) => `<button>b${i}</button>`,
    ).join("");
    const snap = inject<A11ySnapshot>(KERNEL, {
      op: "snapshot",
      filter: "interactive",
      max: 5,
    });
    expect(snap.count).toBe(5);
    expect(snap.total).toBe(12);
    expect(snap.truncated).toBe(true);
  });
});

describe("results cross a structured-clone boundary", () => {
  it("returns only cloneable values — executeScript has no other channel", () => {
    // `find` builds its candidates around a live `el`, and returning one would
    // throw "could not be cloned" in the extension while working perfectly on
    // the desktop, where the value never leaves the process.
    document.body.innerHTML = `<button>Only</button>`;
    const found = inject<A11yFindResult>(KERNEL, {
      op: "find",
      query: "only",
      max: MAX_FIND_MATCHES,
    });
    expect(() => structuredClone(found)).not.toThrow();
    expect(Object.keys(found.matches[0])).not.toContain("el");
  });
});
