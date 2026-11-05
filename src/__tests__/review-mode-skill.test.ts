import { describe, it, expect } from "vitest";
import { loadSkill } from "@/lib/skills/skill-loader";
import { getSkillNameForMode } from "@/lib/skills/skill-registry";
import { getActiveModeReanchor } from "@/lib/tools/mode-prompt-bundle";

/**
 * Review reviews the part the user names and follows what is connected to it
 * (owner, 2026-10-29): target → callers → data → other repos → shared state →
 * an answer with the path to each point. Before this it reviewed "code
 * changes", promised a grep it does not have ("relevance-ranked,
 * symbol-annotated" — grep is plain ripgrep) and called approval-gated
 * commands BLOCKED.
 */
describe("Review mode skill", () => {
  it("the six steps are global (every mode); Review keeps its own part and does not repeat them", async () => {
    const { constructSystemPromptParts } = await import("@/prompts/system_prompt");
    const steps = [
      /Understand the target/,
      /Find every caller/,
      /Follow the data/,
      /other services and repos/,
      /shared state/,
      /Answer what the user asked/,
    ];
    for (const mode of ["ask", "plan", "build", "debug", "review"] as const) {
      const { stableHeader } = constructSystemPromptParts({
        chatMode: mode === "build" || mode === "debug" ? "build" : "ask",
        effectiveWorkMode: mode,
        hasWorkspace: true,
      });
      for (const step of steps) expect(stableHeader).toMatch(step);
      expect(stableHeader).toMatch(/read outside the workspace without approval/);
    }
    const skill = await loadSkill(getSkillNameForMode("review")!);
    expect(skill).not.toMatch(/Find every caller/);
    expect(skill).toMatch(/\*\*Affected:\*\*/);
  });

  it("claims nothing the tools or the gate do not do", async () => {
    const skill = await loadSkill(getSkillNameForMode("review")!);
    expect(skill).not.toMatch(/relevance-ranked|symbol-annotated/);
    expect(skill).not.toMatch(/\bBLOCKED\b/);
  });

  it("re-anchors on the named part, not on a diff", () => {
    expect(getActiveModeReanchor("review")).toMatch(/the part the user named/);
  });
});
