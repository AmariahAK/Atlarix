import { describe, it, expect } from "vitest";
import { getActiveModeReanchor } from "@/lib/tools/mode-prompt-bundle";

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
