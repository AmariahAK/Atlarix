import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  REUSE_FIRST_LADDER,
  applySharedPromptFragments,
} from "@/lib/prompts/shared-fragments";

const REPO_ROOT = path.resolve(__dirname, "../..");

function read(rel: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, rel), "utf8");
}

/**
 * The reuse-first ladder is the main agent's accuracy spine, and a writer
 * sub-agent needs it MORE: it works from a narrow scope with no view of what
 * already exists, which makes it the actor most likely to write a helper that is
 * already three files over. But sub-agents get no AGENTS.md at all — their whole
 * system prompt is the small skill file.
 *
 * One source, spliced into both. A second hand-maintained copy is how the mode
 * label drifted until the header and <tools_registry> disagreed inside one
 * rendered prompt.
 */
describe("shared prompt fragments", () => {
  it("substitutes a known placeholder", () => {
    const out = applySharedPromptFragments("before\n{{REUSE_FIRST_LADDER}}\nafter");
    expect(out).toContain("climb this ladder");
    expect(out).not.toContain("{{REUSE_FIRST_LADDER}}");
  });

  it("leaves an unknown placeholder visible rather than blanking it", () => {
    // A visible {{TYPO}} in the prompt is a bug you can see; a silently missing
    // paragraph is one you cannot.
    expect(applySharedPromptFragments("a {{NOT_A_FRAGMENT}} b")).toBe(
      "a {{NOT_A_FRAGMENT}} b",
    );
  });

  it("is a no-op on text with no placeholders", () => {
    expect(applySharedPromptFragments("plain text")).toBe("plain text");
  });

  it("AGENTS.md and the writer sub-agent both request the ladder", () => {
    expect(read("AGENTS.md")).toContain("{{REUSE_FIRST_LADDER}}");
    expect(read("src/skills/subagents/subagent-writer.md")).toContain(
      "{{REUSE_FIRST_LADDER}}",
    );
  });

  it("neither file hardcodes a second copy of the ladder", () => {
    const marker = "Is it already in the codebase? Reuse it.";
    expect(read("AGENTS.md")).not.toContain(marker);
    expect(read("src/skills/subagents/subagent-writer.md")).not.toContain(marker);
    expect(REUSE_FIRST_LADDER).toContain(marker);
  });

  it("the ladder still carries the security non-negotiable", () => {
    // Trimming complexity is the point; trimming validation is not.
    expect(REUSE_FIRST_LADDER).toContain("Never cut corners on validation");
    expect(REUSE_FIRST_LADDER).toContain("trust-boundary checks");
  });

  it("the read-only scout does NOT get it — it writes no code", () => {
    const scout = read("src/skills/subagents/subagent.md");
    expect(scout).not.toContain("{{REUSE_FIRST_LADDER}}");
    expect(scout).toContain("READ-ONLY");
  });
});
