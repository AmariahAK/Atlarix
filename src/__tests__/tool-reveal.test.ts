/**
 * Per-mode progressive tool reveal.
 *
 * The load-bearing properties, in order of what breaks worst if they regress:
 *
 *  1. NOTHING is withheld. Tiering touches descriptions only — a peripheral
 *     tool's name and schema still bind, so it is always callable and nothing is
 *     lost across compaction.
 *  2. The tiering is PER MODE. A tool that is the job in one mode and incidental
 *     in another must differ between them, or this is just a global trim wearing
 *     a per-mode label.
 *  3. A peripheral description still says what the tool is AND how to get the
 *     rest, because a one-liner that does neither degrades tool selection on
 *     exactly the weak models this exists to help.
 */

import { describe, expect, it } from "vitest";
import "@/lib/tools";
import { ToolRegistry } from "@/lib/tools/registry";
import {
  describeToolForMode,
  peripheralToolNames,
  revealSavings,
  revealTierForMode,
} from "@/lib/tools/tool-reveal";
import { MODE_SYSTEM_TOOL_LISTS } from "@/lib/tools/mode-tool-registry";

const LONG = "A".repeat(1200);

function meta(name: string) {
  const m = ToolRegistry.get(name);
  if (!m) throw new Error(`tool ${name} is not registered`);
  return m;
}

describe("tool reveal tiering", () => {
  it("keeps a mode's workhorses at full description", () => {
    expect(revealTierForMode("run_command", LONG, "build")).toBe("core");
    expect(revealTierForMode("edit_file", LONG, "build")).toBe("core");
    expect(revealTierForMode("read_file", LONG, "ask")).toBe("core");
    expect(describeToolForMode(meta("run_command"), "build")).toBe(
      meta("run_command").description,
    );
  });

  it("tiers per MODE, not globally", () => {
    // `plan` is the artifact Plan mode exists to author, and incidental in Explore.
    expect(revealTierForMode("plan", LONG, "plan")).toBe("core");
    expect(revealTierForMode("plan", LONG, "ask")).toBe("peripheral");
    // `edit_file` is the job in Build and not in Explore's surface at all.
    expect(revealTierForMode("edit_file", LONG, "build")).toBe("core");
    expect(revealTierForMode("edit_file", LONG, "ask")).toBe("peripheral");
    // Debug mirrors Build.
    expect(revealTierForMode("edit_file", LONG, "debug")).toBe("core");
  });

  it("never tiers an already-pointer-sized description", () => {
    // Trimming a 300-char description buys nothing and costs an indirection.
    expect(
      revealTierForMode("some_tiny_tool", "Short and to the point.", "build"),
    ).toBe("core");
  });

  it("a peripheral description keeps meaning AND names the way to get the rest", () => {
    const automations = meta("automations");
    const bound = describeToolForMode(automations, "ask");

    expect(bound).not.toBe(automations.description);
    expect(bound.length).toBeLessThan(automations.description.length);
    // Still says what it is…
    expect(bound.length).toBeGreaterThan(20);
    // …and exactly how to get the rest, naming itself so there is no guessing.
    expect(bound).toContain('tool_help({tool:"automations"})');
  });

  it("never trims a description that exists to prevent a known mistake", () => {
    // A pointer answers "how do I use this". It cannot answer "do not do the
    // obvious wrong thing", because a model about to make the mistake does not
    // know it should go read more first — it reads the short version, falls into
    // the lure, and tool_help is never called.
    //
    // browser_inspect's wording was rewritten in v14.8.9 to remove a "VISUAL
    // confirmation" lure that caused an observed bug, and in 15.11 to say when
    // a screenshot helps instead of forbidding it. It is peripheral by every other measure — long, and not a
    // workhorse in any mode — and must still bind in full.
    for (const mode of ["ask", "plan", "build", "debug", "review"] as const) {
      expect(revealTierForMode("browser_inspect", LONG, mode)).toBe("core");
      expect(describeToolForMode(meta("browser_inspect"), mode)).toBe(
        meta("browser_inspect").description,
      );
    }
    expect(meta("browser_inspect").description).toContain("cheap way to see a page");
  });

  it("tool_help is core in every mode — the pointer must never dead-end", () => {
    for (const mode of ["ask", "plan", "build", "debug", "review"] as const) {
      expect(revealTierForMode("tool_help", LONG, mode)).toBe("core");
    }
  });

  it("tool_help is in every mode's allowlist", () => {
    for (const mode of ["ask", "plan", "review"] as const) {
      expect(MODE_SYSTEM_TOOL_LISTS[mode]).toContain("tool_help");
    }
    // build/debug use the "*" marker — everything is allowed there by definition.
    expect(MODE_SYSTEM_TOOL_LISTS.build).toEqual(["*"]);
    expect(MODE_SYSTEM_TOOL_LISTS.debug).toEqual(["*"]);
  });

  it("actually saves description budget on a realistic Build surface", () => {
    const surface = [
      "automations",
      "browser_inspect",
      "browser",
      "run_command",
      "edit_file",
      "read_file",
      "grep",
    ].map(meta);

    const { full, bound } = revealSavings(surface, "build");
    expect(bound).toBeLessThan(full);
    // The point of the exercise: a meaningful fraction, not a rounding error.
    expect(full - bound).toBeGreaterThan(3000);
  });

  it("reports which tools were trimmed, so the reveal is never silent", () => {
    const surface = ["automations", "run_command", "read_file"].map(meta);
    const trimmed = peripheralToolNames(surface, "build");
    expect(trimmed).toContain("automations");
    expect(trimmed).not.toContain("run_command");
    expect(trimmed).not.toContain("read_file");
  });
});
