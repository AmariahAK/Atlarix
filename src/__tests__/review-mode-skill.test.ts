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
  it("walks the six steps and answers with a path", async () => {
    const skill = await loadSkill(getSkillNameForMode("review")!);
    for (const step of [
      /Understand the target/,
      /Find every caller/,
      /Follow the data/,
      /other services and repos/,
      /shared state/,
      /Answer what the user asked/,
    ]) {
      expect(skill).toMatch(step);
    }
    expect(skill).toMatch(/read outside the workspace without approval/);
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
