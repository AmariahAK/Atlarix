import { describe, it, expect } from "vitest";
import { labelForWorkMode } from "@/lib/work-mode";
import { getModeRegistryDisplayLabel } from "@/lib/tools/mode-tool-registry";
import { getActiveModeHeaderBlock } from "@/lib/tools/mode-prompt-bundle";
import type { WorkMode } from "@/lib/schemas";

/**
 * The name the prompt calls a mode must be the name the user can see and click.
 *
 * These had drifted: the prompt's `MODE_LABELS` said "Fix" for `debug` while the
 * mode picker (`labelForWorkMode`) said "Debug". Because the mode header
 * interpolates the label, the shipped prompt read "You are in Fix mode (the UI
 * labels it Fix…)" — asserting something about the UI that was false. A user
 * asking to "switch to Debug mode" was naming a mode the prompt had another word
 * for.
 *
 * Consolidating the prompt's own copies wasn't enough, because that left one
 * prompt-side map as a rival to the UI's. Now there is exactly one source.
 */

const MODES: WorkMode[] = ["ask", "plan", "build", "debug", "review"];

describe("mode labels: prompt == UI", () => {
  it.each(MODES)("%s renders the same label on both sides", (mode) => {
    expect(getModeRegistryDisplayLabel(mode)).toBe(labelForWorkMode(mode));
  });

  it("debug is called Debug, matching the picker", () => {
    expect(labelForWorkMode("debug")).toBe("Debug");
    expect(getModeRegistryDisplayLabel("debug")).toBe("Debug");
  });

  it("the mode header names the mode the way the UI does", () => {
    for (const mode of MODES) {
      expect(getActiveModeHeaderBlock(mode)).toContain(
        `## Current mode: ${labelForWorkMode(mode)}`,
      );
    }
  });

  it("no prompt surface still says 'Fix mode'", () => {
    for (const mode of MODES) {
      expect(getActiveModeHeaderBlock(mode)).not.toMatch(/\bFix mode\b/);
    }
  });

  // ask→Explore is a deliberate display rename over the unchanged enum value, and
  // it must survive: skills authored with `compatibleModes: [Explore]` match on it.
  it("keeps the ask→Explore display rename", () => {
    expect(labelForWorkMode("ask")).toBe("Explore");
    expect(getModeRegistryDisplayLabel("ask")).toBe("Explore");
  });
});
