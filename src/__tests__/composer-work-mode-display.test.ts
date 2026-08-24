/**
 * What the composer says the work mode is.
 *
 * Two bugs met here. The footer resolved the mode from the GLOBAL preference alone —
 * never updated when sessions gained their own mode in v14.36.0 — while the picker
 * beside it resolved `session ?? global`. So the two could name different modes with
 * nothing on screen to say which was in force, and switching mode during a turn made
 * it look as though the UI had frozen.
 *
 * Both now share `resolveSelectedWorkMode`, and the footer shows the mode the RUNNING
 * turn was dispatched with, because a turn's mode is fixed at dispatch and cannot be
 * retargeted mid-flight.
 */

import { describe, it, expect } from "vitest";
import {
  resolveSelectedWorkMode,
  resolveDisplayedWorkMode,
} from "@/lib/work-mode";
import { readFileSync } from "node:fs";

describe("resolveSelectedWorkMode — one rule for the footer and the picker", () => {
  it("prefers the session's own mode over the global preference", () => {
    // The regression: a session deliberately set to Plan, in a window whose global
    // preference has since moved to Build.
    expect(
      resolveSelectedWorkMode({
        sessionWorkMode: "plan",
        workModePreference: "build",
        selectedChatMode: "build",
      }),
    ).toBe("plan");
  });

  it("falls back to the global preference for a session with no stored mode", () => {
    expect(
      resolveSelectedWorkMode({
        sessionWorkMode: null,
        workModePreference: "debug",
        selectedChatMode: "build",
      }),
    ).toBe("debug");
  });

  it("falls back to the chat mode when neither is set", () => {
    expect(resolveSelectedWorkMode({ selectedChatMode: "ask" })).toBe("ask");
    expect(resolveSelectedWorkMode({ selectedChatMode: "build" })).toBe("build");
    expect(resolveSelectedWorkMode({ selectedChatMode: "agent" })).toBe("build");
    expect(resolveSelectedWorkMode({})).toBe("ask");
  });
});

describe("resolveDisplayedWorkMode — the running turn wins while it runs", () => {
  it("shows the mode the live turn was dispatched with, not the newly picked one", () => {
    // The reported case: a Debug turn is streaming and the user picks Build. The turn
    // keeps running as Debug, so the footer must keep saying Debug.
    expect(
      resolveDisplayedWorkMode({ selected: "build", runningWorkMode: "debug" }),
    ).toBe("debug");
  });

  it("shows the selected mode when no turn is running", () => {
    expect(
      resolveDisplayedWorkMode({ selected: "build", runningWorkMode: undefined }),
    ).toBe("build");
    expect(
      resolveDisplayedWorkMode({ selected: "plan", runningWorkMode: null }),
    ).toBe("plan");
  });

  it("agrees with the picker once the picked mode matches the running turn", () => {
    expect(
      resolveDisplayedWorkMode({ selected: "debug", runningWorkMode: "debug" }),
    ).toBe("debug");
  });
});

describe("every control that sets the mode goes through one place", () => {
  // The Shift+Tab cycle wrote only the GLOBAL preference while the picker wrote the
  // global AND stamped the session. Because a turn dispatches with
  // `workModeOverride ?? sessionWorkMode`, that made the chord a no-op with a toast
  // in any session that had a stored mode — it did not merely fail to redraw, the
  // next turn genuinely ran in the old mode. Asserted structurally because the
  // alternative is mounting a global key listener to prove a negative.
  const shortcuts = readFileSync("src/hooks/usePanelShortcuts.ts", "utf8");
  const picker = readFileSync("src/components/ChatIntentSelector.tsx", "utf8");

  it("the Shift+Tab cycle uses the shared setter", () => {
    expect(shortcuts).toContain("useWorkModeSelection");
  });

  it("the picker uses the shared setter", () => {
    expect(picker).toContain("useWorkModeSelection");
  });

  it("neither writes the work-mode settings patch directly any more", () => {
    // `settingsPatchForWorkMode` is the global-only write. Reaching for it outside
    // the shared hook is exactly how the two controls drifted apart.
    expect(shortcuts).not.toContain("settingsPatchForWorkMode");
    expect(picker).not.toContain("settingsPatchForWorkMode");
  });

  it("the cycle steps from the resolved mode, not the raw global preference", () => {
    expect(shortcuts).toContain("WORK_MODE_CYCLE.indexOf(workMode)");
    expect(shortcuts).not.toContain("settings?.workModePreference ??");
  });
});
