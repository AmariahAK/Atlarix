/**
 * The composer's rotating tips.
 *
 * The interesting tests are the two that stop this being annoying: it must not
 * change under someone who is typing, and it must not show the same string
 * twice in a row (which is what made a random pick the wrong choice).
 */

import { describe, expect, it } from "vitest";
import { TIPS, firstTip, mayRotate, nextTip } from "./composer-tips";

describe("the pool", () => {
  it("has no duplicates, which a rotation would surface as a stutter", () => {
    expect(new Set(TIPS).size).toBe(TIPS.length);
  });

  it("stays short enough to read inside a 320px panel", () => {
    // Not a pixel measurement — a ceiling that keeps anyone from pasting a
    // paragraph in here. The placeholder truncates silently, so a long tip is
    // a tip nobody ever finishes reading.
    for (const tip of TIPS) expect(tip.length).toBeLessThanOrEqual(64);
  });

  it("opens on the tip worth seeing if you only ever see one", () => {
    expect(firstTip()).toBe(TIPS[0]);
  });
});

describe("rotation", () => {
  it("never repeats the tip already on screen", () => {
    for (const tip of TIPS) expect(nextTip(tip)).not.toBe(tip);
  });

  it("visits every tip before coming back round", () => {
    const seen: string[] = [];
    let tip = firstTip();
    for (let i = 0; i < TIPS.length; i++) {
      seen.push(tip);
      tip = nextTip(tip);
    }
    expect(new Set(seen).size).toBe(TIPS.length);
    expect(tip).toBe(firstTip());
  });

  it("starts the cycle on a string it does not recognise", () => {
    // The HTML's own default on first load, and any tip deleted in a later
    // release. Neither may throw.
    expect(nextTip("Ask about this page…")).toBe(TIPS[0]);
    expect(nextTip("")).toBe(TIPS[0]);
  });
});

describe("when it may rotate", () => {
  it("holds while the user has typed something", () => {
    expect(mayRotate({ value: "how do I", running: false })).toBe(false);
  });

  it("treats whitespace as empty, not as a draft", () => {
    expect(mayRotate({ value: "   \n ", running: false })).toBe(true);
  });

  it("holds during a turn", () => {
    expect(mayRotate({ value: "", running: true })).toBe(false);
  });

  it("allows it between turns with an empty composer", () => {
    expect(mayRotate({ value: "", running: false })).toBe(true);
  });
});
