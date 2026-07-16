import { describe, it, expect } from "vitest";
import {
  formatPrioritySkillsForPrompt,
  normalizeMode,
  type PrioritySkill,
} from "@/lib/skills/priority-skill-loader";

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

describe("formatPrioritySkillsForPrompt mode matching", () => {
  it("applies a compatibleModes:[Explore] skill in ask mode", () => {
    const out = formatPrioritySkillsForPrompt(
      [skill({ name: "Explore-only", modes: ["Explore"] })],
      "ask",
    );
    expect(out).toContain("Explore-only");
  });

  it("matches Title-case display labels against the lowercase enum", () => {
    const out = formatPrioritySkillsForPrompt(
      [skill({ name: "Builder", modes: ["Build", "Review"] })],
      "build",
    );
    expect(out).toContain("Builder");
  });

  it("excludes a skill whose modes do not cover the current mode", () => {
    const out = formatPrioritySkillsForPrompt(
      [skill({ name: "Debug-only", modes: ["Debug"] })],
      "ask",
    );
    expect(out).toBe("");
  });

  it("a wildcard mode still applies everywhere", () => {
    const out = formatPrioritySkillsForPrompt(
      [skill({ name: "Everywhere", modes: ["*"] })],
      "review",
    );
    expect(out).toContain("Everywhere");
  });
});
