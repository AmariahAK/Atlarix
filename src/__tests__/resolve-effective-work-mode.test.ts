import { describe, expect, it } from "vitest";
import { resolveEffectiveWorkMode } from "@/lib/work-mode";

describe("resolveEffectiveWorkMode", () => {
  it("uses workModePreference for manual Plan selection", () => {
    expect(
      resolveEffectiveWorkMode({
        intentMode: "ask",
        workModePreference: "plan",
        selectedChatMode: "ask",
      }),
    ).toBe("plan");
  });

  it("uses workModePreference for Fix and Review", () => {
    expect(
      resolveEffectiveWorkMode({
        intentMode: "ask",
        workModePreference: "debug",
        selectedChatMode: "ask",
      }),
    ).toBe("debug");
    expect(
      resolveEffectiveWorkMode({
        intentMode: "ask",
        workModePreference: "review",
        selectedChatMode: "ask",
      }),
    ).toBe("review");
  });

  it("Auto intent collapses to ask or build only", () => {
    expect(
      resolveEffectiveWorkMode({
        intentMode: "auto",
        workModePreference: "plan",
        selectedChatMode: "ask",
      }),
    ).toBe("ask");
    expect(
      resolveEffectiveWorkMode({
        intentMode: "auto",
        workModePreference: "plan",
        selectedChatMode: "build",
      }),
    ).toBe("build");
  });

  it("workModeOverride wins", () => {
    expect(
      resolveEffectiveWorkMode({
        workModeOverride: "review",
        intentMode: "ask",
        workModePreference: "plan",
        selectedChatMode: "ask",
      }),
    ).toBe("review");
  });
});
