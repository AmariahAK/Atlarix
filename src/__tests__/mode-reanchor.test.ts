import { describe, it, expect } from "vitest";
import { getActiveModeReanchor, BROWSER_NOTE } from "@/lib/tools/mode-prompt-bundle";

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

describe("v14.8.9 BROWSER_NOTE — visual is the way to SEE; screenshot is last resort", () => {
  it("steers 'see the page' to the visual/text text report, not a screenshot", () => {
    expect(BROWSER_NOTE).toMatch(/mode:"visual"/);
    // visual/text IS the answer (screenshot framed as last resort, not the way to "see")
    expect(BROWSER_NOTE).toMatch(/these ARE the answer/i);
  });
  it("frames screenshot as a last resort, never for reading/finding/layout", () => {
    expect(BROWSER_NOTE).toMatch(/LAST RESORT/i);
    // must NOT tell the model to screenshot in order to "see" the page (the bug)
    expect(BROWSER_NOTE).not.toMatch(/screenshot[^.]*\bto SEE\b/i);
  });
});
