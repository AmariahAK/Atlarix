/**
 * W4 (Windows fresh-install QA, 2026-11-07): Explore's prompt says "call
 * ask_user to switch to Build/Debug", so the answer to that question is the
 * user's own mode choice. Only a clear yes counts; a "no, don't switch" or a
 * mention of Build inside a longer answer is not a switch.
 */
import { describe, expect, it } from "vitest";
import { workModeChosenInAnswers } from "@/lib/work-mode";

describe("workModeChosenInAnswers", () => {
  it.each([
    ["Yes, switch to Build (Recommended)", "build"],
    ["Switch to Build", "build"],
    ["yes - switch to debug mode", "debug"],
    ["Please switch to Debug", "debug"],
    ["Switch to Build mode", "build"],
  ])("%s → %s", (answer, mode) => {
    expect(workModeChosenInAnswers([answer])).toBe(mode);
  });

  it.each([
    "No, stay in Explore",
    "Don't switch to Build",
    "No, don't switch to Build yet",
    "Explain why I would switch to Build",
    "Spaces",
    "",
  ])("%s → no switch", (answer) => {
    expect(workModeChosenInAnswers([answer])).toBeNull();
  });

  it("takes the switch from any one of several answers", () => {
    expect(workModeChosenInAnswers(["Tabs", "Yes, switch to Build"])).toBe("build");
  });

  it("refuses to guess when answers pick different modes", () => {
    expect(workModeChosenInAnswers(["Switch to Build", "Switch to Debug"])).toBeNull();
  });
});
