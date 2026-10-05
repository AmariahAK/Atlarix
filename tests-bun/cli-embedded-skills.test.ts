/**
 * The bundled skills as a folder (src/runtime/embedded-skills.ts). A compiled
 * binary's embedded files sit flat under hashed names, so they are written out
 * once; files already in their folder are used where they are.
 */
import { describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { skillsDirFrom } from "../src/runtime/embedded-skills";

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
    const dir = skillsDirFrom(files, home)!;
    expect(dir.startsWith(path.join(home, ".atlarix", "skills"))).toBe(true);
    expect(fs.readFileSync(path.join(dir, "subagents", "subagent.md"), "utf8")).toBe("scout");
    expect(fs.readFileSync(path.join(dir, "modes", "build-mode.md"), "utf8")).toBe("build");
    expect(skillsDirFrom(files, home)).toBe(dir);
    // A new version of a prompt is a new folder, never an edit to one in use.
    fs.writeFileSync(path.join(flat, "subagent-a1b2.md"), "scout v2");
    expect(skillsDirFrom(files, home)).not.toBe(dir);
  });

  it("files already in their folder are used there, nothing written", () => {
    const root = path.resolve(import.meta.dir, "..", "src", "skills");
    const home = tmp();
    const files = {
      "subagents/subagent.md": path.join(root, "subagents", "subagent.md"),
      "modes/build-mode.md": path.join(root, "modes", "build-mode.md"),
    };
    expect(skillsDirFrom(files, home)).toBe(root);
    expect(fs.existsSync(path.join(home, ".atlarix"))).toBe(false);
  });

  it("no skills, no folder", () => {
    expect(skillsDirFrom(undefined)).toBeUndefined();
    expect(skillsDirFrom({})).toBeUndefined();
  });
});
