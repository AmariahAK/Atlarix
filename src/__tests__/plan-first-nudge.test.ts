import { describe, it, expect } from "vitest";
import { getActiveModeHeaderBlock } from "@/lib/tools/mode-prompt-bundle";
import { getModeToolAllowlist } from "@/lib/tools/mode-tool-registry";

/**
 * A user who just starts building — no plan, no structure — should get one
 * offered rather than watching the agent free-run through a dozen files and
 * only discover the shape at the end. The nudge lives in the mode header that
 * already owns plan lifecycle, so plan guidance stays in one place instead of
 * being split across two surfaces.
 */

describe("plan-first nudge (Build / Fix)", () => {
  it("Build tells the agent to write a plan when the work is broad and none exists", () => {
    const header = getActiveModeHeaderBlock("build");
    expect(header).toContain("NO plan in context");
    expect(header).toContain('plan(operation:"write")');
  });

  it("Build also tells it NOT to plan a trivial change", () => {
    // A nudge with no off-switch turns every one-line fix into ceremony.
    expect(getActiveModeHeaderBlock("build")).toMatch(
      /single scoped change needs no plan/i,
    );
  });

  it("Fix orders it AFTER the hypothesis, not before", () => {
    // Planning a bug you haven't diagnosed commits you to a guess — the exact
    // thing hypothesis-first mode exists to prevent.
    const header = getActiveModeHeaderBlock("debug");
    expect(header).toContain('plan(operation:"write")');
    expect(header).toMatch(/AFTER the hypothesis, never before/);
  });

  it("the plan tool is actually bound in both modes, so the advice is actionable", () => {
    for (const mode of ["build", "debug"] as const) {
      const allow = getModeToolAllowlist(mode);
      // Build/Fix use the all-tools marker rather than enumerating.
      expect(allow.includes("plan") || allow.includes("*")).toBe(true);
    }
  });

  it("read-only modes are untouched — no build-shaped plan nudge there", () => {
    for (const mode of ["ask", "review"] as const) {
      expect(getActiveModeHeaderBlock(mode)).not.toContain(
        "NO plan in context",
      );
    }
  });
});
