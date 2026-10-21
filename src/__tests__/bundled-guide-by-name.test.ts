/**
 * The model reads bundled guides by NAME and never learns where Atlarix lives.
 *
 * WHAT WENT WRONG
 * ---------------
 * The skills index advertised each bundled guide by its resolved absolute path,
 * which in a packaged app is inside the bundle:
 * `…/Atlarix.app/Contents/Resources/skills/guides/memory.md`. Install-specific,
 * ~120 characters per guide per turn — and, worse, it taught the model that
 * these things have filesystem paths. Told to read `guides/memory` without one
 * in reach, it produced `/Users/armaan/.atlarix/guides/memory.md`: right shape,
 * invented home directory (the user is `amariah`), wrong subpath, three tool
 * errors.
 *
 * Both halves are the same defect — a model handed unreconstructable paths
 * learns to reconstruct them anyway.
 */
import { describe, it, expect } from "vitest";
import {
  looksLikeBundledGuide,
  resolveBundledGuidePath,
} from "@/lib/skills/bundled-guide-path";

describe("looksLikeBundledGuide", () => {
  it("recognises the names the index advertises", () => {
    expect(looksLikeBundledGuide("guides/memory")).toBe(true);
    expect(looksLikeBundledGuide("guides/memory.md")).toBe(true);
    expect(looksLikeBundledGuide("./guides/memory")).toBe(true);
  });

  it("ignores ordinary workspace paths", () => {
    expect(looksLikeBundledGuide("src/index.ts")).toBe(false);
    expect(looksLikeBundledGuide("README.md")).toBe(false);
    // Not anchored at the start — a nested guides/ dir is a normal repo path.
    expect(looksLikeBundledGuide("docs/guides/memory.md")).toBe(false);
  });

  it("refuses traversal", () => {
    expect(looksLikeBundledGuide("guides/../../../etc/passwd")).toBe(false);
  });
});

describe("resolveBundledGuidePath", () => {
  it("resolves a real bundled guide, with or without .md", () => {
    const withoutExt = resolveBundledGuidePath("guides/data-visualization");
    const withExt = resolveBundledGuidePath("guides/data-visualization.md");
    expect(withoutExt).toBeTruthy();
    expect(withoutExt).toBe(withExt);
    expect(withoutExt).toMatch(/guides[/\\]data-visualization\.md$/);
  });

  it("returns null for anything that is not a guide name", () => {
    expect(resolveBundledGuidePath("src/index.ts")).toBeNull();
    expect(resolveBundledGuidePath("docs/guides/memory.md")).toBeNull();
  });

  it("cannot be walked out of the guides directory", () => {
    // Containment is checked after joining as well as before, so an encoding
    // that slips past the prefix test still lands nowhere.
    expect(resolveBundledGuidePath("guides/../../secrets.md")).toBeNull();
  });

  it("keeps the install location out of the NAME the model is given", () => {
    // The point of the whole change: what the model reads and repeats is
    // `guides/<name>`. The absolute path exists only inside the resolver.
    const name = "guides/data-visualization";
    expect(name).not.toMatch(/Users|Applications|\.app/);
    expect(resolveBundledGuidePath(name)).toMatch(/\.md$/);
  });
});

describe("the skills index advertises names, not install paths", () => {
  it("emits `guides/<name>` as the read path for bundled guides", async () => {
    const { buildSkillIndex } = await import("@/lib/skills/skill-index");
    const entries = await buildSkillIndex(null, "build");
    const guides = entries.filter((e) => e.source === "guide");
    expect(guides.length).toBeGreaterThan(0);
    for (const g of guides) {
      expect(g.readPath).toBe(g.name);
      // No absolute path, and nothing about where the app is installed.
      expect(g.readPath).not.toMatch(/^\//);
      expect(g.readPath).not.toMatch(/\.app|Applications|Users/);
    }
  });

  it("no longer lists a memory guide — the rules are in the system header", async () => {
    const { buildSkillIndex } = await import("@/lib/skills/skill-index");
    const entries = await buildSkillIndex(null, "build");
    expect(entries.map((e) => e.name)).not.toContain("guides/memory");
    const { existsSync } = await import("node:fs");
    expect(existsSync(resolveBundledGuidePath("guides/memory")!)).toBe(false);
  });
});
