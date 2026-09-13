/**
 * The kernel's ACTION ops.
 *
 * Evaluated in GLOBAL scope, like `page-scripts-injectable.test.tsx` and for the
 * same reason: a stringified function does not carry its module, so a single
 * surviving module reference is a ReferenceError in the page — on whichever
 * branch touches it, which for a brand-new branch is every one of these.
 *
 * WHAT THESE ARE REALLY FOR. Each case below is a way an action reports success
 * while doing nothing, or fails with a message the model cannot act on. Those
 * are the only two outcomes worth testing: a click that works is visible
 * immediately, and a click that silently does not is three wasted turns.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  atlarixPageKernel,
  type PageActionResult,
  type PageRequest,
  type A11ySnapshot,
  MAX_ELEMENTS,
} from "@/lib/browser/page-scripts";

const KERNEL = atlarixPageKernel.toString();

function run<T>(req: PageRequest): T {
  return new Function(
    `return (${KERNEL})(${JSON.stringify(req)})`,
  )() as unknown as T;
}

const act = (req: PageRequest) => run<PageActionResult>(req);

/** Mint refs the way a real run does: read the page first. */
function snapshot(): A11ySnapshot {
  return run<A11ySnapshot>({
    op: "snapshot",
    filter: "interactive",
    max: MAX_ELEMENTS,
  });
}

const realRect = Element.prototype.getBoundingClientRect;
beforeEach(() => {
  document.body.innerHTML = "";
  Element.prototype.getBoundingClientRect = function () {
    return {
      width: 100,
      height: 20,
      top: 40,
      left: 10,
      right: 110,
      bottom: 60,
    };
  } as unknown as typeof realRect;
  // jsdom implements neither, and both are called on every action path.
  Element.prototype.scrollIntoView = function () {};
});
afterEach(() => {
  Element.prototype.getBoundingClientRect = realRect;
  delete (window as unknown as Record<string, unknown>).__atlarixRefs;
  delete (window as unknown as Record<string, unknown>).__atlarixRefSeq;
});

describe("resolving", () => {
  it("prefers the ref over a selector, because a ref is ours and a selector is a guess", () => {
    document.body.innerHTML = `<button id="a" aria-label="Alpha">A</button><button id="b" aria-label="Beta">B</button>`;
    const ref = snapshot().elements[1].ref;
    const out = act({ op: "resolve", ref, selector: "#a" });
    expect(out.ok).toBe(true);
    expect(out.label).toBe("Beta");
  });

  it("falls back to the selector when the ref has gone", () => {
    document.body.innerHTML = `<button aria-label="Only">x</button>`;
    const out = act({ op: "resolve", ref: "e999", selector: "button" });
    expect(out.ok).toBe(true);
    expect(out.label).toBe("Only");
  });

  it("returns the CENTRE of the element, so a pointer lands inside it", () => {
    // A trusted pointer event takes coordinates, not a node. Aiming at the
    // top-left corner hits the border on anything with a radius.
    document.body.innerHTML = `<button aria-label="Go">Go</button>`;
    // `left`/`top` as well as the centre: the desktop draws a RING around the
    // element, and a centre point alone cannot describe a rectangle.
    expect(act({ op: "resolve", selector: "button" }).rect).toEqual({
      x: 60,
      y: 50,
      left: 10,
      top: 40,
      width: 100,
      height: 20,
    });
  });

  it("says a stale ref means re-read, rather than just 'not found'", () => {
    const out = act({ op: "resolve", ref: "e42" });
    expect(out.ok).toBe(false);
    expect(out.error).toContain("read the page again");
  });

  it("reports an invalid CSS selector instead of throwing out of the page", () => {
    // `querySelector` throws a SyntaxError on a malformed selector, and a throw
    // inside the kernel surfaces as an opaque injection failure.
    const out = act({ op: "resolve", selector: "!!! not a selector" });
    expect(out.ok).toBe(false);
    expect(out.error).toContain("No element matched");
  });
});

describe("click", () => {
  it("clicks the element the ref points at", () => {
    document.body.innerHTML = `<button aria-label="Save">Save</button>`;
    let clicked = 0;
    document.querySelector("button")?.addEventListener("click", () => {
      clicked += 1;
    });
    const ref = snapshot().elements[0].ref;
    const out = act({ op: "click", ref });
    expect(out.ok).toBe(true);
    expect(clicked).toBe(1);
    expect(out.label).toBe("Save");
  });

  it("names what it clicked, so the model can confirm it hit the right thing", () => {
    document.body.innerHTML = `<a href="/x" aria-label="Open settings">gear</a>`;
    expect(act({ op: "click", selector: "a" }).label).toBe("Open settings");
  });
});

describe("fill walks to the field, which is the bug that made this necessary", () => {
  it("fills an input inside a WRAPPER the ref points at", () => {
    // Wikipedia's Vector search box: the snapshot names the wrapper "search
    // input" because that is its accessible ROLE, and the real input is inside.
    document.body.innerHTML = `<div role="search" aria-label="Search"><input name="q"></div>`;
    const out = act({
      op: "fill",
      selector: "div[role=search]",
      value: "otters",
    });
    expect(out.ok).toBe(true);
    expect(out.tag).toBe("input");
    expect(document.querySelector("input")?.value).toBe("otters");
  });

  it("walks OUTWARD when the ref landed on a node INSIDE the field", () => {
    // `closest` walks ancestors, so this is the rich-text case: the snapshot
    // named a span inside the editable region, and the editable region is the
    // thing that can actually be filled. A sibling field is NOT reachable this
    // way and deliberately is not — guessing at siblings is how an agent fills
    // the wrong box on a form with six of them.
    document.body.innerHTML = `<div contenteditable="true" aria-label="Body"><span id="hint">old</span></div>`;
    const out = act({ op: "fill", selector: "#hint", value: "a draft" });
    expect(out.ok).toBe(true);
    expect(document.querySelector("div")?.textContent).toBe("a draft");
  });

  it("tells the model to CLICK first when there is no field at all", () => {
    // The message has to name the next move. "Illegal invocation" cost three
    // turns precisely because it named only the fault.
    document.body.innerHTML = `<div role="combobox" aria-label="Pick one">Pick one</div>`;
    const out = act({ op: "fill", selector: "div", value: "x" });
    expect(out.ok).toBe(false);
    expect(out.error).toContain('role="combobox"');
    expect(out.error).toContain("click this ref");
  });

  it("fires input AND change, which is what a framework listens for", () => {
    // Setting `.value` alone updates the DOM and leaves React's state stale, so
    // the page looks filled and submits empty.
    document.body.innerHTML = `<input name="q">`;
    const seen: string[] = [];
    const input = document.querySelector("input")!;
    input.addEventListener("input", () => seen.push("input"));
    input.addEventListener("change", () => seen.push("change"));
    act({ op: "fill", selector: "input", value: "hello" });
    expect(seen).toEqual(["input", "change"]);
  });

  it("uses the native setter, which is the only thing React notices", () => {
    // React reads the value through its own descriptor; a plain assignment is
    // invisible to it. This asserts the setter was used, not merely that the
    // value changed — both look identical from outside.
    document.body.innerHTML = `<input name="q">`;
    const input = document.querySelector("input")!;
    let viaSetter = 0;
    const native = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!;
    Object.defineProperty(HTMLInputElement.prototype, "value", {
      ...native,
      set(this: HTMLInputElement, v: string) {
        viaSetter += 1;
        native.set!.call(this, v);
      },
    });
    try {
      act({ op: "fill", selector: "input", value: "typed" });
    } finally {
      Object.defineProperty(HTMLInputElement.prototype, "value", native);
    }
    expect(viaSetter).toBeGreaterThan(0);
    expect(input.value).toBe("typed");
  });
});

describe("fill by control type", () => {
  it("toggles a checkbox rather than assigning its value", () => {
    document.body.innerHTML = `<input type="checkbox" name="agree">`;
    act({ op: "fill", selector: "input", value: true });
    expect(document.querySelector<HTMLInputElement>("input")?.checked).toBe(
      true,
    );
  });

  it("reads the words a model actually writes for false", () => {
    document.body.innerHTML = `<input type="checkbox" name="agree" checked>`;
    act({ op: "fill", selector: "input", value: "no" });
    expect(document.querySelector<HTMLInputElement>("input")?.checked).toBe(
      false,
    );
  });

  it("matches a select by its visible TEXT, not only its value", () => {
    // The value-vs-label mismatch is the commonest reason a select fill does
    // nothing at all and reports success.
    document.body.innerHTML = `<select><option value="gb">United Kingdom</option><option value="ke">Kenya</option></select>`;
    const out = act({ op: "fill", selector: "select", value: "Kenya" });
    expect(out.ok).toBe(true);
    expect(document.querySelector<HTMLSelectElement>("select")?.value).toBe(
      "ke",
    );
  });

  it("lists the real options when none matched", () => {
    document.body.innerHTML = `<select><option value="a">Alpha</option></select>`;
    const out = act({ op: "fill", selector: "select", value: "Omega" });
    expect(out.ok).toBe(false);
    expect(out.error).toContain("Alpha");
  });

  it("sets textContent on a contenteditable, where the native setter would throw", () => {
    // NOTE FOR THE NEXT PERSON: jsdom does not implement `isContentEditable` —
    // it reads false on an element whose attribute plainly says otherwise. The
    // kernel checks the attribute as well, which is right in a real browser too
    // (the property is computed from rendering, so it is false for a detached
    // or hidden subtree) and is the only reason this passes here.
    document.body.innerHTML = `<div contenteditable="true" aria-label="Body"></div>`;
    const out = act({ op: "fill", selector: "div", value: "a draft" });
    expect(out.ok).toBe(true);
    expect(document.querySelector("div")?.textContent).toBe("a draft");
  });
});

describe("scroll", () => {
  beforeEach(() => {
    Object.defineProperty(window, "innerHeight", {
      value: 800,
      configurable: true,
    });
    Object.defineProperty(document.documentElement, "scrollHeight", {
      value: 5000,
      configurable: true,
    });
  });

  it("reports where it ended up and how far there is to go", () => {
    const out = act({ op: "scroll", direction: "down" });
    expect(out.ok).toBe(true);
    expect(out.scrollMax).toBe(4200);
  });

  it("takes an explicit amount over the viewport default", () => {
    let by: number | undefined;
    window.scrollBy = ((_x: number, y: number) => {
      by = y;
    }) as typeof window.scrollBy;
    act({ op: "scroll", direction: "down", amount: 250 });
    expect(by).toBe(250);
  });

  it("scrolls UP as a negative delta", () => {
    let by: number | undefined;
    window.scrollBy = ((_x: number, y: number) => {
      by = y;
    }) as typeof window.scrollBy;
    act({ op: "scroll", direction: "up", amount: 120 });
    expect(by).toBe(-120);
  });
});

describe("every action result crosses a structured-clone boundary", () => {
  it("returns no live element — executeScript has no other channel", () => {
    // Returning `el` would throw "could not be cloned" in the extension while
    // working perfectly on the desktop, where the value never leaves the
    // process. The two backends would disagree about the same code.
    document.body.innerHTML = `<input name="q">`;
    for (const req of [
      { op: "resolve" as const, selector: "input" },
      { op: "click" as const, selector: "input" },
      { op: "fill" as const, selector: "input", value: "x" },
      { op: "scroll" as const, direction: "down" as const },
    ]) {
      expect(() => structuredClone(act(req))).not.toThrow();
    }
  });
});

/**
 * The on-screen pointer.
 *
 * ONE IMPLEMENTATION FOR BOTH SURFACES as of 2026-09-13. The desktop drew it and
 * the extension did not, so a page in the user's own browser filled itself in
 * silence — and "the form filled itself" is alarming in a way that "I watched it
 * get filled" is not.
 */
describe("the AI cursor", () => {
  const CURSOR = "#__atlarix_ai_cursor__";

  it("is not drawn unless asked for", () => {
    // A read must not decorate the user's page.
    document.body.innerHTML = `<button>Go</button>`;
    act({ op: "resolve", selector: "button" });
    expect(document.querySelector(CURSOR)).toBeNull();
  });

  it("draws a pointer, a ring and a labelled chip", () => {
    document.body.innerHTML = `<button>Go</button>`;
    act({ op: "resolve", selector: "button", cursor: "click" });
    const host = document.querySelector(CURSOR);
    expect(host).not.toBeNull();
    expect(host?.querySelector('[data-part="pointer"]')).not.toBeNull();
    expect(host?.querySelector('[data-part="ring"]')).not.toBeNull();
    expect(host?.querySelector('[data-part="chip"]')?.textContent).toBe(
      "click",
    );
  });

  it("reuses ONE container across actions rather than stacking them", () => {
    document.body.innerHTML = `<button>Go</button><a href="/x">Link</a>`;
    act({ op: "resolve", selector: "button", cursor: "click" });
    act({ op: "resolve", selector: "a", cursor: "hover" });
    expect(document.querySelectorAll(CURSOR)).toHaveLength(1);
    expect(
      document.querySelector(`${CURSOR} [data-part="chip"]`)?.textContent,
    ).toBe("hover");
  });

  it("never intercepts the action it illustrates", () => {
    // pointer-events:none is the whole reason an overlay is safe to draw over a
    // page the agent is about to click.
    document.body.innerHTML = `<button>Go</button>`;
    act({ op: "resolve", selector: "button", cursor: "click" });
    const host = document.querySelector<HTMLElement>(CURSOR);
    expect(host?.style.pointerEvents).toBe("none");
    for (const part of ["pointer", "ring", "chip"]) {
      const el = host?.querySelector<HTMLElement>(`[data-part="${part}"]`);
      expect(el?.style.pointerEvents).toBe("none");
    }
  });

  it("truncates a long label rather than drawing a paragraph on the page", () => {
    document.body.innerHTML = `<button>Go</button>`;
    act({ op: "resolve", selector: "button", cursor: "x".repeat(200) });
    const chip = document.querySelector(`${CURSOR} [data-part="chip"]`);
    expect(chip?.textContent?.length).toBeLessThanOrEqual(40);
  });

  it("still resolves when drawing the cursor is impossible", () => {
    // A hostile page, a detached body, no layout — none of it may turn a
    // working action into a failed one.
    document.body.innerHTML = `<button>Go</button>`;
    const raf = window.requestAnimationFrame;
    (window as unknown as Record<string, unknown>).requestAnimationFrame =
      () => {
        throw new Error("no frames here");
      };
    try {
      expect(
        act({ op: "resolve", selector: "button", cursor: "click" }).ok,
      ).toBe(true);
    } finally {
      window.requestAnimationFrame = raf;
    }
  });
});
