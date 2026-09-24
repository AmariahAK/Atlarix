import { describe, it, expect } from "vitest";
import {
  getActiveModeReanchor,
  renderModePromptBundle,
} from "@/lib/tools/mode-prompt-bundle";
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
    expect(s).toMatch(/no edit_file/i);
  });

  it("the read-only modes say what they cannot do, without over-stating it", () => {
    for (const m of ["ask", "plan", "review"] as const) {
      const s = getActiveModeReanchor(m);
      expect(s).toMatch(/no edit_file/i);
      // "asks the user first" — a PAUSE, not a refusal. A model told a command
      // is impossible stops trying; a model told it needs approval waits.
      expect(s).toMatch(/asks the user/i);
    }
    expect(getActiveModeReanchor("build")).toMatch(/implementation/i);
    expect(getActiveModeReanchor("debug")).toMatch(/hypothesis/i);
  });

  /**
   * THE REGRESSION GUARD FOR THIS WHOLE CHANGE.
   *
   * Explore, Plan and Review used to claim a command "fails at the OS layer" and
   * that mutating run_command was "BLOCKED". Both were false on at least one
   * platform even before the profile moved, and the first is false everywhere
   * now: the workspace is writable, and a source edit is stopped by an approval
   * card, not by the kernel. Claude Code shipped and then fixed this exact class
   * of defect — instructions over-stating what the sandbox enforces.
   *
   * The deny set for `.git/config`, `.git/hooks` and `.atlarix/` IS kernel-
   * enforced on macOS Seatbelt and Linux bwrap — and is NOT on the bundled
   * Landlock helper or Windows Low IL, neither of which has a deny primitive. A
   * prompt cannot be true per-platform, so it must not make the claim at all.
   */
  it("no read-only mode block claims OS-level enforcement", () => {
    const forbidden = [/OS layer/i, /\bBLOCKED\b/, /read-only sandbox/i];
    for (const m of ["ask", "plan", "review"] as const) {
      const text = `${renderModePromptBundle(m)}\n${getActiveModeReanchor(m)}`;
      for (const re of forbidden) {
        expect(text, `${m} must not claim ${re}`).not.toMatch(re);
      }
    }
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
    // v14.41: browser 6→2. Both facts used to live on a tool each; they now ride
    // the consolidated `browser` description. Reading it via the RETIRED names
    // would still pass (they resolve as aliases) and would therefore not notice
    // if the prose had been dropped in the move — so assert on the canonical
    // tool, which is the one actually bound in the prompt.
    const browserDesc = String(ToolRegistry.get("browser")!.description);
    expect(browserDesc).toMatch(/every tab shares the user's browser session/i);
    expect(browserDesc).toMatch(/localhost/i);
    // v14.52.0: browser_test is gone; "did my change throw?" is a console read
    // since the last navigate, and the description has to say so.
    expect(desc()).toMatch(/since your last navigate/i);
  });
});
