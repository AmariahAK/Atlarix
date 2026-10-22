/**
 * The bundled skills as a folder (src/runtime/embedded-skills.ts). A compiled
 * binary's embedded files sit flat under hashed names, so they are written out
 * once; files already in their folder are used where they are.
 */
import { describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { bundledSkillsDir, registerBundledSkills, skillsCacheRoot, skillsDirFrom } from "../src/runtime/embedded-skills";
import { binDir } from "../src/runtime/embedded-bin";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "skills-"));

describe("bundled skills folder", () => {
  it("embedded (flat) files are written out once, as a folder, by content", () => {
    const flat = tmp();
    const home = tmp();
    fs.writeFileSync(path.join(flat, "subagent-a1b2.md"), "scout");
    fs.writeFileSync(path.join(flat, "build-mode-c3d4.md"), "build");
    const files = {
      "subagents/subagent.md": path.join(flat, "subagent-a1b2.md"),
      "modes/build-mode.md": path.join(flat, "build-mode-c3d4.md"),
    };
    const dir = skillsDirFrom(files, path.join(home, ".atlarix"))!;
    expect(dir.startsWith(path.join(home, ".atlarix", "skills"))).toBe(true);
    expect(fs.readFileSync(path.join(dir, "subagents", "subagent.md"), "utf8")).toBe("scout");
    expect(fs.readFileSync(path.join(dir, "modes", "build-mode.md"), "utf8")).toBe("build");
    expect(skillsDirFrom(files, path.join(home, ".atlarix"))).toBe(dir);
    // A new version of a prompt is a new folder, never an edit to one in use.
    fs.writeFileSync(path.join(flat, "subagent-a1b2.md"), "scout v2");
    expect(skillsDirFrom(files, path.join(home, ".atlarix"))).not.toBe(dir);
  });

  it("files already in their folder are used there, nothing written", () => {
    const root = path.resolve(import.meta.dir, "..", "src", "skills");
    const home = tmp();
    const files = {
      "subagents/subagent.md": path.join(root, "subagents", "subagent.md"),
      "modes/build-mode.md": path.join(root, "modes", "build-mode.md"),
    };
    expect(skillsDirFrom(files, path.join(home, ".atlarix"))).toBe(root);
    expect(fs.existsSync(path.join(home, ".atlarix"))).toBe(false);
  });

  it("a scratch profile keeps its copies in its own folder, never the person's ~/.atlarix (QA, 2026-10-21)", () => {
    // Asserted on where the copies go, without writing any: run against the old code, a
    // version of this test that wrote a copy put it in the real ~/.atlarix/skills.
    const scratch = tmp();
    const was = { ud: process.env.ATLARIX_USER_DATA_DIR, home: process.env.ATLARIX_HOME_DIR };
    process.env.ATLARIX_USER_DATA_DIR = scratch;
    delete process.env.ATLARIX_HOME_DIR;
    try {
      expect(skillsCacheRoot()).toBe(path.join(scratch, "atlarix-home", "skills"));
      expect(binDir()).toBe(path.join(scratch, "atlarix-home", "bin"));
    } finally {
      if (was.ud === undefined) delete process.env.ATLARIX_USER_DATA_DIR;
      else process.env.ATLARIX_USER_DATA_DIR = was.ud;
      if (was.home !== undefined) process.env.ATLARIX_HOME_DIR = was.home;
    }
  });

  it("no skills, no folder", () => {
    expect(skillsDirFrom(undefined)).toBeUndefined();
    expect(skillsDirFrom({})).toBeUndefined();
  });

  it("the build's skills are written out on first use, not at startup (`--version`, QA 2026-10-21)", () => {
    const flat = tmp();
    const home = path.join(tmp(), ".atlarix");
    fs.writeFileSync(path.join(flat, "subagent-a1b2.md"), "scout");
    const was = process.env.ATLARIX_SKILLS_DIR;
    delete process.env.ATLARIX_SKILLS_DIR;
    try {
      registerBundledSkills({ "subagents/subagent.md": path.join(flat, "subagent-a1b2.md") }, home);
      expect(fs.existsSync(home)).toBe(false);
      const dir = bundledSkillsDir()!;
      expect(fs.readFileSync(path.join(dir, "subagents", "subagent.md"), "utf8")).toBe("scout");
      expect(process.env.ATLARIX_SKILLS_DIR).toBe(dir);
      expect(bundledSkillsDir()).toBe(dir);
    } finally {
      if (was === undefined) delete process.env.ATLARIX_SKILLS_DIR;
      else process.env.ATLARIX_SKILLS_DIR = was;
    }
  });
});
