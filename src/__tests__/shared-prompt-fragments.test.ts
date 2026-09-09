import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  OUTSIDE_WORKSPACE_PATHS,
  REUSE_FIRST_LADDER,
  applySharedPromptFragments,
} from "@/lib/prompts/shared-fragments";
import { BUILTIN_AGENTS } from "@/lib/agents/builtin-agents";

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
    const out = applySharedPromptFragments(
      "before\n{{REUSE_FIRST_LADDER}}\nafter",
    );
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
    expect(read("src/skills/subagents/subagent-writer.md")).not.toContain(
      marker,
    );
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

/**
 * The outside-workspace spelling rule.
 *
 * The tools allowed cross-repo reads (and gated writes) for a release before
 * anything SAID so — the permission existed only in parameter descriptions. Asked to
 * look at a sibling repo, the agent read the workspace as a wall and went to
 * `pwd`/`ls`/`find`, then guessed the wrong parent directory. Every consumer of the
 * rule must therefore actually receive it, and the WRITE half must reach only agents
 * that have `edit_file` — naming a tool an agent cannot call is the failure the
 * v14.22.0 standing guard exists to catch.
 */
describe("outside-workspace path fragments", () => {
  const READ_MARKER = "Reaching outside the workspace";
  const WRITE_MARKER = "asks the user once for that folder";

  it("substitutes both placeholders", () => {
    const out = applySharedPromptFragments(
      "{{OUTSIDE_WORKSPACE_PATHS}} {{OUTSIDE_WORKSPACE_WRITES}}",
    );
    expect(out).toContain(READ_MARKER);
    expect(out).toContain(WRITE_MARKER);
    expect(out).not.toContain("{{");
  });

  it("states absolute as the canonical spelling, not '../'", () => {
    // One form, taught once. The point of the fragment is that the model stops
    // having to guess which spelling a given tool accepts.
    expect(OUTSIDE_WORKSPACE_PATHS).toContain("absolute path");
    expect(OUTSIDE_WORKSPACE_PATHS).toContain("read_file");
    expect(OUTSIDE_WORKSPACE_PATHS).toContain("glob");
    expect(OUTSIDE_WORKSPACE_PATHS).toContain("grep");
  });

  it("tells the agent not to shell out or guess a path", () => {
    // Both halves of the observed failure: it used `find`, and it invented
    // ~/Github/<project> for a project that lived somewhere else entirely.
    expect(OUTSIDE_WORKSPACE_PATHS).toMatch(/find/);
    expect(OUTSIDE_WORKSPACE_PATHS).toMatch(/don't guess/i);
  });

  it("the READ half reaches every agent prompt", () => {
    expect(read("AGENTS.md")).toContain("{{OUTSIDE_WORKSPACE_PATHS}}");
    expect(read("src/skills/subagents/subagent.md")).toContain(
      "{{OUTSIDE_WORKSPACE_PATHS}}",
    );
    expect(read("src/skills/subagents/subagent-writer.md")).toContain(
      "{{OUTSIDE_WORKSPACE_PATHS}}",
    );
    for (const agent of Object.values(BUILTIN_AGENTS)) {
      expect(agent.systemPrompt, `builtin agent: ${agent.name}`).toContain(
        READ_MARKER,
      );
    }
  });

  it("the WRITE half reaches ONLY prompts whose agent has edit_file", () => {
    expect(read("AGENTS.md")).toContain("{{OUTSIDE_WORKSPACE_WRITES}}");
    expect(read("src/skills/subagents/subagent-writer.md")).toContain(
      "{{OUTSIDE_WORKSPACE_WRITES}}",
    );
    // The read-only scout must not be told how outside writes work.
    expect(read("src/skills/subagents/subagent.md")).not.toContain(
      "{{OUTSIDE_WORKSPACE_WRITES}}",
    );
    for (const agent of Object.values(BUILTIN_AGENTS)) {
      const canWrite = agent.tools?.includes("edit_file") ?? false;
      expect(
        agent.systemPrompt?.includes(WRITE_MARKER) ?? false,
        `builtin agent: ${agent.name} (canWrite=${canWrite})`,
      ).toBe(canWrite);
    }
  });

  it("no agent prompt still claims paths are workspace-relative only", () => {
    // The stale wording that contradicted the new rule.
    for (const agent of Object.values(BUILTIN_AGENTS)) {
      expect(agent.systemPrompt, `builtin agent: ${agent.name}`).not.toContain(
        "cite workspace-relative paths",
      );
    }
  });
});
