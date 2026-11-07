/**
 * W7 (Windows fresh-install QA, 2026-11-07): the work-mode coachmark said
 * "Choose Ask, Plan, Build, Debug, or Review for a fixed tool surface" while
 * the chip right under it read "Explore". The mode's id is still `ask`; every
 * word a user reads calls it Explore (labelForWorkMode), and "tool surface" is
 * our jargon, not theirs.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const src = readFileSync(
  path.resolve(__dirname, "../components/ChatIntentSelector.tsx"),
  "utf8",
);
/** Text inside JSX string literals and template strings, not identifiers. */
const visibleStrings = [...src.matchAll(/"([^"\n]{12,})"|`([^`\n]{12,})`/g)].map((m) => m[1] ?? m[2]!);

describe("work-mode copy", () => {
  it("never calls the read-only mode Ask", () => {
    expect(visibleStrings.filter((s) => /\bAsk\b/.test(s))).toEqual([]);
  });

  it("does not say tool surface", () => {
    expect(visibleStrings.filter((s) => /tool surface/i.test(s))).toEqual([]);
  });
});
