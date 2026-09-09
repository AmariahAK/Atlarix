import { describe, it, expect } from "vitest";
import {
  filterSkillsForMode,
  normalizeMode,
  type PrioritySkill,
} from "@/lib/skills/priority-skill-loader";
import {
  SKILL_INDEX_INLINE_MAX,
  formatSkillIndexForPrompt,
  type SkillIndexEntry,
} from "@/lib/skills/skill-index";

function skill(overrides: Partial<PrioritySkill>): PrioritySkill {
  return {
    name: "Test Skill",
    description: "",
    tags: [],
    modes: [],
    priority: false,
    version: "1.0.0",
    content: "do the thing",
    filename: "test.md",
    ...overrides,
  };
}

function entry(overrides: Partial<SkillIndexEntry> = {}): SkillIndexEntry {
  return {
    name: "Test Skill",
    description: "Does the thing.",
    readPath: ".atlarix/skills/test.md",
    source: "repo",
    ...overrides,
  };
}

// WS6: the ask→explore rename is display-only — the runtime WorkMode value is
// still "ask". Skills authored with the display label ("Explore", Title-case)
// must still match the "ask" mode, or their mode restriction silently drops.
describe("normalizeMode (ask↔explore fold)", () => {
  it("folds the Explore display label onto the ask enum value, case-insensitively", () => {
    expect(normalizeMode("Explore")).toBe("ask");
    expect(normalizeMode("explore")).toBe("ask");
    expect(normalizeMode("  EXPLORE ")).toBe("ask");
    expect(normalizeMode("ask")).toBe("ask");
    expect(normalizeMode("Build")).toBe("build");
  });
});

describe("filterSkillsForMode", () => {
  const names = (s: PrioritySkill[]) => s.map((x) => x.name);

  it("applies a compatibleModes:[Explore] skill in ask mode", () => {
    expect(
      names(
        filterSkillsForMode(
          [skill({ name: "Explore-only", modes: ["Explore"] })],
          "ask",
        ),
      ),
    ).toEqual(["Explore-only"]);
  });

  it("matches Title-case display labels against the lowercase enum", () => {
    expect(
      names(
        filterSkillsForMode(
          [skill({ name: "Builder", modes: ["Build", "Review"] })],
          "build",
        ),
      ),
    ).toEqual(["Builder"]);
  });

  it("excludes a skill whose modes do not cover the current mode", () => {
    expect(
      filterSkillsForMode(
        [skill({ name: "Debug-only", modes: ["Debug"] })],
        "ask",
      ),
    ).toEqual([]);
  });

  it("a wildcard mode still applies everywhere", () => {
    expect(
      names(
        filterSkillsForMode(
          [skill({ name: "Everywhere", modes: ["*"] })],
          "review",
        ),
      ),
    ).toEqual(["Everywhere"]);
  });
});

// v14.25.0: skills reach the prompt as an INDEX. The body must NOT be there —
// that is the whole point of the change — and every entry must get a line, so a
// skill can never silently fall off the end the way the old 10/6KB/24KB caps
// let it.
describe("formatSkillIndexForPrompt", () => {
  it("emits name, description and read path — and no body", () => {
    const out = formatSkillIndexForPrompt([
      entry({ name: "pdf-tools", description: "Extract PDF form fields." }),
    ]);
    expect(out).toContain("pdf-tools");
    expect(out).toContain("Extract PDF form fields.");
    expect(out).toContain(".atlarix/skills/test.md");
    expect(out).toContain("read_file");
  });

  it("indexes EVERY skill — no cap, no truncation marker", () => {
    const many = Array.from({ length: 25 }, (_, i) =>
      entry({ name: `skill-${i}`, readPath: `.atlarix/skills/s${i}/SKILL.md` }),
    );
    const out = formatSkillIndexForPrompt(many);
    for (const s of many) {
      expect(out).toContain(s.name);
      expect(out).toContain(s.readPath);
    }
    expect(out).toContain("Skills available (25)");
    expect(out).not.toContain("…");
  });

  /**
   * Beyond the inline bound the list is cut — but never SILENTLY, which is the actual
   * invariant the test above protects. The old 10/6KB/24KB caps dropped skills with no
   * indication, so the model was told that skills 11+ did not exist. Here the heading
   * still counts all of them, the remainder is stated outright, and the directory is
   * named so `grep` reaches them — no dedicated search tool, because grep already does
   * this.
   *
   * The bound sits well above any realistic workspace, so this path is for the
   * pathological case only — which is exactly why it needs a test: nobody will hit it
   * by accident and notice it is wrong.
   */
  it("states what it omitted, and how to reach it", () => {
    const many = Array.from({ length: SKILL_INDEX_INLINE_MAX + 7 }, (_, i) =>
      entry({ name: `skill-${i}`, readPath: `.atlarix/skills/s${i}/SKILL.md` }),
    );
    const out = formatSkillIndexForPrompt(many);

    // The count is of everything that EXISTS, not of what was printed. A heading that
    // counted only the shown ones would be the silent-drop failure wearing a number.
    expect(out).toContain(`Skills available (${SKILL_INDEX_INLINE_MAX + 7})`);
    expect(out).toContain("and 7 more");
    expect(out).toContain(".atlarix/skills/");
    expect(out).toContain("grep");

    // The first are listed in full; the tail is not pretended into existence.
    expect(out).toContain("skill-0");
    expect(out).toContain(`skill-${SKILL_INDEX_INLINE_MAX - 1}`);
    expect(out).not.toContain(`skill-${SKILL_INDEX_INLINE_MAX + 6}`);
  });

  it("a skill with a huge body still costs only its index line", () => {
    const out = formatSkillIndexForPrompt([
      entry({ name: "huge", description: "One line." }),
    ]);
    // The index never reads the file, so length is bounded by the metadata.
    expect(out.length).toBeLessThan(600);
  });

  it("renders nothing when there are no skills", () => {
    expect(formatSkillIndexForPrompt([])).toBe("");
  });

  // A bundled guide's path points INSIDE the installed app, not into a project.
  // Listed flat among workspace skills, a model read that absolute path as
  // somewhere it could work and prefixed a command with
  // `cd <app>/Contents/Resources` — after which every relative filename in the
  // user's repo stopped resolving. The path must stay (read_file needs it), so
  // the section says what the directory is and that it is not a place to go.
  it("separates built-in guides and warns they are not the workspace", () => {
    const out = formatSkillIndexForPrompt([
      entry({ name: "house-style", source: "repo" }),
      entry({
        name: "guides/memory",
        source: "guide",
        readPath:
          "/Applications/Atlarix.app/Contents/Resources/skills/guides/memory.md",
      }),
    ]);
    expect(out).toContain("## Skills available (1)");
    expect(out).toContain("## Built-in guides (1)");
    expect(out).toMatch(/inside the Atlarix application/i);
    expect(out).toMatch(/Never `cd` into these paths/i);
    expect(out).toMatch(/working directory is the project folder/i);
  });

  it("omits the guides section entirely when there are none", () => {
    const out = formatSkillIndexForPrompt([entry({ source: "repo" })]);
    expect(out).not.toContain("Built-in guides");
  });

  it("omits the skills section when only guides exist", () => {
    const out = formatSkillIndexForPrompt([
      entry({
        name: "guides/memory",
        source: "guide",
        readPath: "/app/skills/guides/memory.md",
      }),
    ]);
    expect(out).toContain("Built-in guides (1)");
    expect(out).not.toContain("## Skills available");
  });
});
