/**
 * `normalizeConsoleLevel` maps Electron's two `console-message` shapes onto our
 * own vocabulary.
 *
 * The legacy positional signature carries an INTEGER documented as "0 to 3 … in
 * order it matches verbose, info, warning and error". The code this replaced
 * read those as `2 = error` and `3 = warning` — inverted. Electron 38 always
 * takes the string branch so it never bit in practice, but on that path every
 * warning would have blocked a turn while every real error sailed through the
 * completion gate. These cases pin the documented order.
 */

import { describe, expect, it } from "vitest";
import { normalizeConsoleLevel } from "@/ipc/utils/browser_view_manager";

describe("normalizeConsoleLevel", () => {
  it("maps Electron's numeric levels in documented order", () => {
    expect(normalizeConsoleLevel(0)).toBe("debug"); // verbose
    expect(normalizeConsoleLevel(1)).toBe("info");
    expect(normalizeConsoleLevel(2)).toBe("warning");
    expect(normalizeConsoleLevel(3)).toBe("error");
  });

  it("does NOT invert warning and error (the bug this replaced)", () => {
    expect(normalizeConsoleLevel(2)).not.toBe("error");
    expect(normalizeConsoleLevel(3)).not.toBe("warning");
  });

  it("maps the string levels, including aliases", () => {
    expect(normalizeConsoleLevel("error")).toBe("error");
    expect(normalizeConsoleLevel("warning")).toBe("warning");
    expect(normalizeConsoleLevel("warn")).toBe("warning");
    expect(normalizeConsoleLevel("info")).toBe("info");
    expect(normalizeConsoleLevel("debug")).toBe("debug");
    expect(normalizeConsoleLevel("verbose")).toBe("debug");
    expect(normalizeConsoleLevel("log")).toBe("log");
  });

  it("is case-insensitive", () => {
    expect(normalizeConsoleLevel("ERROR")).toBe("error");
    expect(normalizeConsoleLevel("Warning")).toBe("warning");
  });

  it("falls back to the NON-blocking level for anything unrecognized", () => {
    // A wrong guess must never be able to trap a turn.
    for (const weird of ["", "assert", "table", undefined, 99]) {
      const level = normalizeConsoleLevel(weird as never);
      expect(level).not.toBe("error");
    }
    expect(normalizeConsoleLevel(undefined)).toBe("log");
  });
});
