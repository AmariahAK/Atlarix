import { describe, it, expect } from "vitest";
import { getActiveModeReanchor } from "@/lib/tools/mode-prompt-bundle";
import { ToolRegistry } from "@/lib/tools/registry";
import "@/lib/tools";

describe("getActiveModeReanchor (#15 mode-transition re-anchor)", () => {
  it("names the current mode for every mode", () => {
    for (const m of ["ask", "plan", "build", "debug", "review"] as const) {
      expect(getActiveModeReanchor(m)).toMatch(/^Current mode:/);
    }
  });

  it("Plan re-anchor disambiguates 'carve it out' → update the plan (the observed bug)", () => {
    const s = getActiveModeReanchor("plan");
    expect(s).toMatch(/UPDATE THE PLAN/);
    expect(s).toMatch(/carve it out/i);
    expect(s).toMatch(/CANNOT edit source/i);
  });

  it("Explore/Review re-anchors are read-only; Build/Debug are write-capable", () => {
    expect(getActiveModeReanchor("ask")).toMatch(/read-only/i);
    expect(getActiveModeReanchor("ask")).toMatch(/CANNOT edit/i);
    expect(getActiveModeReanchor("review")).toMatch(/read-only/i);
    expect(getActiveModeReanchor("build")).toMatch(/implementation/i);
    expect(getActiveModeReanchor("debug")).toMatch(/hypothesis/i);
  });
});

/**
 * v14.8.9 steer, now enforced where it lives.
 *
 * This used to assert on BROWSER_NOTE, a system-prompt block that rendered in four
 * of five modes whether or not the turn touched a browser. Every line of it moved
 * onto the browser tools themselves (progressive: present only when bound), so the
 * guarantee is asserted on `browser_inspect`'s description instead.
 */
describe("browser_inspect — visual is the way to SEE; screenshot is last resort", () => {
  const desc = () => String(ToolRegistry.get("browser_inspect")!.description);

  it("steers 'see the page' to the visual TEXT report, not a screenshot", () => {
    expect(desc()).toMatch(/"visual"/);
    expect(desc()).toMatch(/PRIMARY way to SEE/i);
  });

  it("frames screenshot as a last resort, never for reading/finding/layout", () => {
    expect(desc()).toMatch(/LAST RESORT/i);
    // Must NOT tell the model to screenshot in order to "see" the page (the bug).
    expect(desc()).not.toMatch(/screenshot[^.]*\bto SEE\b/i);
  });

  it("still carries the guidance that BROWSER_NOTE used to hold", () => {
    // The three facts that existed ONLY in the deleted prompt block.
    expect(String(ToolRegistry.get("browser_tabs")!.description)).toMatch(
      /every tab shares one browser session/i,
    );
    expect(String(ToolRegistry.get("browser_interact")!.description)).toMatch(
      /scroll position/i,
    );
    expect(String(ToolRegistry.get("browser_test")!.description)).toMatch(
      /turn will not finish while the app is throwing runtime errors/i,
    );
  });
});
