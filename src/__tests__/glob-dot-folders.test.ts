/**
 * Skills live in `.atlarix/skills/`, and ripgrep skips dot-folders: the agent's
 * glob for them found nothing (QA 15.7.1). A pattern that names a dot-folder
 * looks in it; .git and broad patterns still skip hidden files.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ToolRegistry } from "@/lib/tools/registry";
import "@/lib/tools/glob";

let ws: string;
beforeAll(() => {
  ws = fs.mkdtempSync(path.join(os.tmpdir(), "atlarix-glob-dot-"));
  fs.mkdirSync(path.join(ws, ".atlarix", "skills"), { recursive: true });
  fs.writeFileSync(
    path.join(ws, ".atlarix", "skills", "release.md"),
    "# Release\n",
  );
  fs.mkdirSync(path.join(ws, ".git"), { recursive: true });
  fs.writeFileSync(path.join(ws, ".git", "config"), "x");
  fs.writeFileSync(path.join(ws, "a.md"), "# A\n");
});
afterAll(() => fs.rmSync(ws, { recursive: true, force: true }));

const run = async (pattern: string): Promise<string> => {
  const raw = (await ToolRegistry.execute("glob", {
    pattern,
    workspace: ws,
  })) as unknown;
  return typeof raw === "string"
    ? raw
    : String((raw as { result?: unknown }).result ?? JSON.stringify(raw));
};

describe("glob and dot-folders", () => {
  it("finds files in a dot-folder the pattern names", async () => {
    expect(await run(".atlarix/skills/*")).toContain("release.md");
    expect(await run("**/.atlarix/skills/*.md")).toContain("release.md");
  });

  it("still leaves .git and hidden folders out of broad patterns", async () => {
    expect(await run(".git/*")).not.toContain("config");
    const md = await run("**/*.md");
    expect(md).toContain("a.md");
    expect(md).not.toContain("release.md");
  });
});
