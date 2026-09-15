/**
 * Every desktop action script must at least PARSE.
 *
 * WHY THIS DID NOT EXIST AND SHOULD HAVE. These strings were built inline inside
 * handlers that need an Electron `WebContentsView`, so the only way to see the
 * text was to run the app and the only way a syntax error announced itself was a
 * broken action at runtime — on whichever action nobody happened to try. Three
 * of this repo's recorded traps are exactly that shape: a backtick inside a
 * COMMENT silently ends the template literal it lands in, and it has done so
 * three times now.
 *
 * `new Function(src)` COMPILES WITHOUT EXECUTING, which is what makes this
 * cheap: no DOM, no browser, no side effects — just the parser. Extracting the
 * builders into pure functions of their arguments is what made it possible at
 * all, and is most of the value of having done so.
 *
 * The second describe is the one that catches the recurring trap directly.
 */

import { describe, expect, it } from "vitest";
import {
  ACTION_SCRIPT_BUILDERS,
  CAPTURE_PRE_STATE_JS,
  SETTLE_AND_DELTA_JS,
  fillScript,
} from "@/lib/browser/action-scripts";

const NAMES = Object.keys(ACTION_SCRIPT_BUILDERS) as Array<
  keyof typeof ACTION_SCRIPT_BUILDERS
>;

describe("every builder produces parseable source", () => {
  it("covers every action, so a sixth cannot be added unguarded", () => {
    // The registry is the point: a new builder that is not in it is a new
    // action nothing checks.
    expect(NAMES.length).toBeGreaterThanOrEqual(7);
  });

  for (const name of NAMES) {
    it(`${name} parses`, () => {
      const src = ACTION_SCRIPT_BUILDERS[name]();
      // Constructing compiles the body. It does NOT run it.
      expect(() => new Function(src)).not.toThrow();
      expect(src.length).toBeGreaterThan(20);
    });
  }
});

describe("no backtick anywhere in the emitted source", () => {
  /**
   * These strings are template literals built FROM template literals. One
   * backtick — in a comment, in a label, in a model-supplied value — ends the
   * literal it is inside, and the failure is a build error pointing somewhere
   * unrelated, or worse, a script that parses into something else.
   */
  for (const name of NAMES) {
    it(`${name} emits none`, () => {
      expect(ACTION_SCRIPT_BUILDERS[name]()).not.toContain("`");
    });
  }

  it("survives a model-supplied value containing one", () => {
    // The value reaches the page through JSON.stringify and never as source, so
    // a backtick in it is data. This asserts that remains true.
    const src = fillScript({ ref: "e1" }, "a ` backtick ${and} a template");
    expect(() => new Function(src)).not.toThrow();
  });

  it("survives a hostile selector", () => {
    const hostile = '"); alert(1); //';
    const src = ACTION_SCRIPT_BUILDERS.click();
    expect(() => new Function(src)).not.toThrow();
    expect(src).not.toContain("alert(1)");
    expect(hostile).toBeTruthy();
  });
});

describe("the shared fragments", () => {
  it("pair up: the delta reads the state the capture wrote", () => {
    // They are separate constants spliced at different points, so nothing else
    // would notice if one were renamed.
    expect(CAPTURE_PRE_STATE_JS).toContain("__pre");
    expect(SETTLE_AND_DELTA_JS).toContain("__pre");
    expect(SETTLE_AND_DELTA_JS).toContain("__delta");
  });

  it("parse together, in the order the scripts splice them", () => {
    expect(
      () =>
        new Function(
          `(async () => { ${CAPTURE_PRE_STATE_JS} ${SETTLE_AND_DELTA_JS} })`,
        ),
    ).not.toThrow();
  });
});

describe("the kernel is reached, not reimplemented", () => {
  it("every targeted script calls the shared kernel", () => {
    // The regression this guards is a future edit quietly inlining a resolve
    // again — which is exactly what was just deleted.
    for (const name of [
      "click",
      "fill",
      "focusForKey",
      "hover",
      "scrollTo",
    ] as const) {
      const src = ACTION_SCRIPT_BUILDERS[name]();
      expect(src).toContain("atlarixPageKernel");
    }
  });
});
