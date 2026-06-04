/**
 * v10: per-hunk diff accept/reject — hunk computation + partial composition.
 */
import { describe, it, expect } from "vitest";
import {
  computeDiffHunks,
  composeContentFromHunks,
} from "@/lib/diff/compose-hunks";

const OLD = [
  "function top() {",
  "  return 1;",
  "}",
  "",
  "const middle = 'unchanged';",
  "const alsoUnchanged = true;",
  "const stillUnchanged = 0;",
  "const yetMore = 'lines';",
  "const padding1 = 1;",
  "const padding2 = 2;",
  "",
  "function bottom() {",
  "  return 2;",
  "}",
  "",
].join("\n");

const NEW = [
  "function top() {",
  "  return 100; // changed",
  "}",
  "",
  "const middle = 'unchanged';",
  "const alsoUnchanged = true;",
  "const stillUnchanged = 0;",
  "const yetMore = 'lines';",
  "const padding1 = 1;",
  "const padding2 = 2;",
  "",
  "function bottom() {",
  "  return 200; // changed",
  "}",
  "",
].join("\n");

describe("computeDiffHunks", () => {
  it("produces separate hunks for distant change regions", () => {
    const hunks = computeDiffHunks(OLD, NEW);
    expect(hunks.length).toBe(2);
    expect(hunks[0]!.addedCount).toBe(1);
    expect(hunks[0]!.removedCount).toBe(1);
    expect(hunks[1]!.addedCount).toBe(1);
  });

  it("returns no hunks for identical content", () => {
    expect(computeDiffHunks(OLD, OLD)).toEqual([]);
  });

  it("assigns correct line numbers", () => {
    const hunks = computeDiffHunks(OLD, NEW);
    const removed = hunks[0]!.lines.find((l) => l.type === "remove");
    expect(removed?.oldLineNum).toBe(2);
    const added = hunks[0]!.lines.find((l) => l.type === "add");
    expect(added?.newLineNum).toBe(2);
  });
});

describe("composeContentFromHunks", () => {
  it("all hunks selected → newContent verbatim", () => {
    expect(composeContentFromHunks(OLD, NEW, [0, 1])).toBe(NEW);
  });

  it("no hunks selected → oldContent verbatim", () => {
    expect(composeContentFromHunks(OLD, NEW, [])).toBe(OLD);
  });

  it("first hunk only → top change applied, bottom kept", () => {
    const out = composeContentFromHunks(OLD, NEW, [0]);
    expect(out).toContain("return 100; // changed");
    expect(out).toContain("return 2;");
    expect(out).not.toContain("return 200");
  });

  it("last hunk only → bottom change applied, top kept", () => {
    const out = composeContentFromHunks(OLD, NEW, new Set([1]));
    expect(out).toContain("return 1;");
    expect(out).toContain("return 200; // changed");
    expect(out).not.toContain("return 100");
  });

  it("handles adjacent hunks (small context) without corruption", () => {
    const a = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10"].join("\n");
    const b = ["one", "2", "3", "4", "5", "6", "7", "8", "9", "ten"].join("\n");
    const hunks = computeDiffHunks(a, b, 2);
    expect(hunks.length).toBe(2);
    expect(composeContentFromHunks(a, b, [0], 2)).toBe(
      ["one", "2", "3", "4", "5", "6", "7", "8", "9", "10"].join("\n"),
    );
    expect(composeContentFromHunks(a, b, [1], 2)).toBe(
      ["1", "2", "3", "4", "5", "6", "7", "8", "9", "ten"].join("\n"),
    );
  });

  it("pure additions and deletions compose correctly", () => {
    const a = "alpha\nbeta\ngamma";
    const b = "alpha\ninserted\nbeta";
    const hunks = computeDiffHunks(a, b);
    expect(hunks.length).toBe(1);
    expect(composeContentFromHunks(a, b, [0])).toBe(b);
  });
});
