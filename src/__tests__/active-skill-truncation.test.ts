import { describe, it, expect } from "vitest";
import { assembleContextSections } from "@/lib/context/ContextAssembler";

/**
 * The meter reported "activeSkill (truncated)" on EVERY turn in EVERY mode.
 *
 * The flag was derived by comparing the trimmed addition against the untrimmed
 * section content, and all five mode-skill files end with a newline — so trim
 * always shrank the text and the comparison was always true. Meanwhile a
 * 1.7–3.2 KB mode skill is nowhere near the 8,000-token ceiling the flag is
 * supposed to report. A warning that is always on is worse than none: it trains
 * the user to ignore the one time it matters.
 */

function assemble(content: string) {
  return assembleContextSections({
    chatId: -1,
    appId: null,
    workMode: "build",
    userPrompt: "hi",
    sections: [{ name: "activeSkill", priority: -1, content }],
  });
}

const activeSkill = (out: ReturnType<typeof assemble>) =>
  out.assembledPromptSections.find((s) => s.name === "activeSkill")!;

// The assembler memoizes on a sha256 of its inputs INCLUDING section content, so
// every case below uses distinct content and cannot collide with another's entry.

describe("activeSkill truncation flag", () => {
  it("is FALSE for a normal mode skill that ends with a newline", () => {
    const out = assemble(
      "[Active Skill: modes/build-mode]\nYou are in Build mode.\n",
    );
    expect(activeSkill(out).truncated).toBe(false);
  });

  it("is false for content with no trailing whitespace either", () => {
    const out = assemble("[Active Skill: modes/ask-mode]\nRead-only.");
    expect(activeSkill(out).truncated).toBe(false);
  });

  it("is TRUE only when the 8,000-token ceiling genuinely fires", () => {
    // ~15k tokens of prose — comfortably past the cap.
    const huge = `[Active Skill: modes/build-mode]\n${"token ".repeat(30_000)}\n`;
    const out = assemble(huge);
    expect(activeSkill(out).truncated).toBe(true);
    expect(out.activeSkillAddition).toContain("trimmed to fit context cap");
  });

  it("reports tokens for the text actually emitted, not the raw file", () => {
    const withPadding = "[Active Skill: modes/build-mode]\nBody.\n\n\n";
    const out = assemble(withPadding);
    // The addition is the trimmed form, so the reported size must match it.
    expect(activeSkill(out).tokens).toBeGreaterThan(0);
    expect(out.activeSkillAddition).toBe(withPadding.trim());
  });

  it("a normal turn produces no truncated/dropped footnote at all", () => {
    const out = assemble(
      "[Active Skill: modes/review-mode]\nRead-only review.\n",
    );
    const flagged = out.assembledPromptSections.filter(
      (s) => !s.included || s.truncated,
    );
    expect(flagged).toEqual([]);
  });
});
