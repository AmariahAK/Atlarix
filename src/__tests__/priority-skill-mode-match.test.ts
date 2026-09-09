import { describe, it, expect } from "vitest";
import {
  filterSkillsForMode,
  normalizeMode,
  type PrioritySkill,
} from "@/lib/skills/priority-skill-loader";
import {
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
  it("names no workspace skill — not the name, not the description, not the path", () => {
    // v14.45: a count replaced the catalogue. The model reaches a skill with grep, and
    // the flat cost is the whole point, so a per-skill detail creeping back in is a
    // regression even though it would look like an improvement.
    const out = formatSkillIndexForPrompt([
      entry({ name: "pdf-tools", description: "Extract PDF form fields." }),
    ]);
    expect(out).not.toContain("pdf-tools");
    expect(out).not.toContain("Extract PDF form fields.");
    expect(out).not.toContain(".atlarix/skills/test.md");
    // But it still says where to look and how.
    expect(out).toContain(".atlarix/skills/");
    expect(out).toContain("read_file");
  });

  /**
   * Workspace skills are a COUNT now, not a catalogue — the model has grep for the
   * rest. What must stay true is that nothing is hidden: the number is of every skill,
   * and the directory is named, so this can never become the old silent-drop failure
   * where the model was told skills 11+ did not exist.
   */
  it("states how many skills there are, and where, without naming them", () => {
    const many = Array.from({ length: 32 }, (_, i) =>
      entry({ name: `skill-${i}`, readPath: `.atlarix/skills/s${i}/SKILL.md` }),
    );
    const out = formatSkillIndexForPrompt(many);

    expect(out).toContain("32");
    expect(out).toContain(".atlarix/skills/");
    expect(out).toContain("grep");

    // Cost is flat: no per-skill line, however many there are.
    expect(out).not.toContain("skill-0");
    expect(out).not.toContain("skill-31");
    expect(out.length).toBeLessThan(600);
  });

  it("costs the same for two skills as for two hundred", () => {
    // The property the count exists for. A catalogue grew with the repo; this does not.
    const mk = (n: number) =>
      formatSkillIndexForPrompt(
        Array.from({ length: n }, (_, i) => entry({ name: `s-${i}` })),
      );
    const small = mk(2);
    const large = mk(200);
    // Identical but for the number itself.
    expect(large.replace(/200/g, "N")).toBe(small.replace(/2/g, "N"));
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
    expect(out).toContain("## Skills (1)");
    expect(out).toContain("## Built-in guides (1)");
    // Guides keep their per-entry lines while workspace skills do not: grep over the
    // project cannot reach inside the app bundle, so a count would make them
    // unreachable rather than merely unlisted.
    expect(out).toContain("guides/memory");
    expect(out).toContain(
      "/Applications/Atlarix.app/Contents/Resources/skills/guides/memory.md",
    );
    expect(out).not.toContain("house-style");
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
