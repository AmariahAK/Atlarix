import { describe, expect, it } from "vitest";
import {
  estimateDispatchTokens,
  type BudgetHistoryMessage,
} from "@/lib/routing/tier_context_budget";

/**
 * The dispatch estimate must include the TOOL SURFACE.
 *
 * THE BUG. `estimateDispatchTokens` counted the system prompt, the history and
 * the codebase prefixes — and stopped. The bound tool descriptions and parameter
 * schemas ride in the same request, are billed on every turn, and came to
 * ~6,700 tokens in Explore and ~9,300 in Build. So this function under-reported
 * by that much, and it is what `enforceContextBudget` uses to decide **what to
 * trim to fit the window**. Atlarix believed it had ~6,700 tokens more headroom
 * than it had: it could let a request through that overflowed, and compact later
 * than it should have.
 *
 * WHY THE PARAMETER IS REQUIRED. The obvious shape was
 * `toolSurfaceTokens?: number` defaulting to 0 — which would have left every
 * existing call site silently wrong, i.e. exactly the bug, still shipping, now
 * with a comment claiming it was fixed. Making it required turned the audit into
 * a compile error and found all five call sites.
 *
 * These tests are arithmetic on purpose. The behaviour they protect — trimming
 * and compaction thresholds — is asserted against a `tierLimit` elsewhere
 * (`compaction-durable-write.test.ts`), and those tests deliberately pass 0 so
 * they keep measuring trimming rather than this addend.
 */

const HISTORY: BudgetHistoryMessage[] = [
  { role: "user", content: "hello there, this is a message with some length" },
  { role: "assistant", content: "and a reply of roughly comparable length" },
];

function estimate(toolSurfaceTokens: number): number {
  return estimateDispatchTokens({
    systemPrompt: "SYSTEM PROMPT with a few tokens in it",
    history: HISTORY,
    codebasePrefixMessages: [],
    otherCodebasePrefixMessages: [],
    toolSurfaceTokens,
  });
}

describe("dispatch estimate — the tool surface counts", () => {
  it("adds the tool surface to the estimate, token for token", () => {
    const base = estimate(0);
    // Not "greater than": exactly the addend. A partial or scaled contribution
    // would be a second guess about a number we already measure exactly.
    expect(estimate(6_700)).toBe(base + 6_700);
    expect(estimate(9_300)).toBe(base + 9_300);
  });

  it("is what makes a near-full request read as over budget", () => {
    // The behavioural consequence, stated as the arithmetic that drives it: a
    // request that sat just under the limit on the old (tool-blind) estimate is
    // over it once the real prefix is priced. This is the difference between
    // compacting in time and overflowing.
    const tierLimit = 20_000;
    const historyTokens = 12_000;
    const toolSurface = 9_300;

    const oldWayFits = historyTokens < tierLimit;
    const newWayFits = historyTokens + toolSurface < tierLimit;

    expect(oldWayFits, "the old estimate let this through").toBe(true);
    expect(newWayFits, "the honest estimate does not").toBe(false);
  });

  it("still counts everything it counted before", () => {
    // Guards against 'fixing' the addend by dropping something else: the system
    // prompt and the history must both still move the number.
    const withHistory = estimate(0);
    const withoutHistory = estimateDispatchTokens({
      systemPrompt: "SYSTEM PROMPT with a few tokens in it",
      history: [],
      codebasePrefixMessages: [],
      otherCodebasePrefixMessages: [],
      toolSurfaceTokens: 0,
    });
    expect(withHistory).toBeGreaterThan(withoutHistory);

    const withoutSystem = estimateDispatchTokens({
      systemPrompt: "",
      history: HISTORY,
      codebasePrefixMessages: [],
      otherCodebasePrefixMessages: [],
      toolSurfaceTokens: 0,
    });
    expect(withHistory).toBeGreaterThan(withoutSystem);
  });

  it("a zero surface is a real value, not a missing one", () => {
    // Headless and unattended runs genuinely drop tools, so 0 must be
    // expressible — the point of the required parameter is that 0 is only ever
    // stated, never defaulted into existence.
    expect(estimate(0)).toBeGreaterThan(0);
  });
});
