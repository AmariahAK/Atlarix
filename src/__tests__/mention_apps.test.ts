import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { parseContextMentions } from "@/shared/parse_mention_apps";
import { extractMentionedContext } from "@/ipc/utils/mention_apps";

describe("parseContextMentions", () => {
  it("parses @file: and @dir: mentions", () => {
    const r = parseContextMentions(
      "Look at @file:src/index.ts and the @dir:src/components folder",
    );
    expect(r.files).toEqual(["src/index.ts"]);
    expect(r.dirs).toEqual(["src/components"]);
  });

  it("dedupes repeated mentions", () => {
    const r = parseContextMentions("@file:a.ts @file:a.ts @dir:x @dir:x");
    expect(r.files).toEqual(["a.ts"]);
    expect(r.dirs).toEqual(["x"]);
  });

  it("ignores bare @, mid-word @, and plain text", () => {
    const r = parseContextMentions("email foo@bar.com and @web are not mentions");
    expect(r.files).toEqual([]);
    expect(r.dirs).toEqual([]);
  });

  it("returns empty for an empty prompt", () => {
    expect(parseContextMentions("")).toEqual({ files: [], dirs: [] });
  });
});

describe("extractMentionedContext", () => {
  let dir: string;

  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "mention-ctx-"));
    await fs.writeFile(path.join(dir, "hello.txt"), "hello world", "utf-8");
    await fs.mkdir(path.join(dir, "lib"), { recursive: true });
    await fs.writeFile(path.join(dir, "lib", "a.ts"), "export const a = 1;", "utf-8");
    await fs.writeFile(path.join(dir, "lib", "b.ts"), "export const b = 2;", "utf-8");
  });

  afterAll(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("returns empty string when nothing is mentioned", async () => {
    expect(await extractMentionedContext({ appPath: dir, files: [], dirs: [] })).toBe("");
  });

  it("injects file contents for a mentioned file", async () => {
    const out = await extractMentionedContext({
      appPath: dir,
      files: ["hello.txt"],
      dirs: [],
    });
    expect(out).toContain("### File: hello.txt");
    expect(out).toContain("hello world");
  });

  it("injects only a listing (not contents) for a mentioned folder", async () => {
    const out = await extractMentionedContext({
      appPath: dir,
      files: [],
      dirs: ["lib"],
    });
    expect(out).toContain("### Folder: lib");
    expect(out).toContain("lib/a.ts");
    expect(out).toContain("lib/b.ts");
    // listing only — file *contents* must not be inlined
    expect(out).not.toContain("export const a = 1;");
  });

  it("notes when a referenced file cannot be read", async () => {
    const out = await extractMentionedContext({
      appPath: dir,
      files: ["does-not-exist.ts"],
      dirs: [],
    });
    expect(out).toContain("### File: does-not-exist.ts");
    expect(out).toContain("(could not read this file)");
  });
});
