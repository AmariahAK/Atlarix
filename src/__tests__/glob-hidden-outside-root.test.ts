/**
 * glob/grep in a folder outside the workspace, under a hidden path (QA 4(c) and
 * A1, 2026-10-22). The memory folder lives under `~/.atlarix…`, and a note just
 * written there came back "no files":
 *
 * - the WORKSPACE's .gitignore was applied to a root outside it (ripgrep matches
 *   an --ignore-file relative to its cwd, the outside root);
 * - an absolute pattern next to a `path` was handed to ripgrep as a glob, which
 *   matched nothing;
 * - `~` was never expanded, in the pattern or the path;
 * - a dot-folder under the root was skipped when the pattern did not name it;
 * - one unreadable folder (ripgrep exits 2 for any walk error, matches or not)
 *   failed the whole search as "Invalid … pattern".
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ToolRegistry } from "@/lib/tools/registry";
import "@/lib/tools/glob";
import "@/lib/tools/grep";

let tmp: string;
let ws: string;
let mem: string;
const realHome = process.env.HOME;
// chmod 000 means nothing to root, and Windows has no such mode.
const canLock = process.platform !== "win32" && process.getuid?.() !== 0;

beforeAll(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "atlarix-glob-hidden-")));
  ws = path.join(tmp, "project");
  mem = path.join(tmp, ".hidden", "memory");
  fs.mkdirSync(path.join(ws, "node_modules", "dep"), { recursive: true });
  fs.writeFileSync(path.join(ws, "node_modules", "dep", "index.ts"), "export const needle = 0;\n");
  fs.writeFileSync(path.join(ws, "main.ts"), "export const needle = 1;\n");
  fs.writeFileSync(path.join(ws, ".gitignore"), "*.md\nnotes/\nnode_modules/\n");
  fs.mkdirSync(path.join(mem, "notes"), { recursive: true });
  fs.mkdirSync(path.join(mem, ".drafts"), { recursive: true });
  fs.writeFileSync(path.join(mem, "note.md"), "# needle\n");
  fs.writeFileSync(path.join(mem, "notes", "deep.md"), "# deep\n");
  fs.writeFileSync(path.join(mem, ".drafts", "draft.md"), "# draft\n");
  // `~` resolves through HOME (os.homedir()).
  process.env.HOME = tmp;
});
afterAll(() => {
  process.env.HOME = realHome;
  for (const d of ["locked"]) {
    try {
      fs.chmodSync(path.join(tmp, "permws", d), 0o755);
    } catch {
      /* not made */
    }
  }
  fs.rmSync(tmp, { recursive: true, force: true });
});

const run = async (tool: string, args: Record<string, unknown>, workspace = ws): Promise<string> => {
  try {
    // glob answers with a string; grep with { success, result | error }, wrapped.
    let raw = (await ToolRegistry.execute(tool, { workspace, ...args })) as unknown;
    while (raw && typeof raw === "object" && "result" in raw) raw = (raw as { result: unknown }).result;
    if (raw && typeof raw === "object" && "error" in raw) return `THREW: ${JSON.stringify(raw)}`;
    return typeof raw === "string" ? raw : JSON.stringify(raw);
  } catch (e) {
    return `THREW: ${(e as Error).message}`;
  }
};

describe("glob outside the workspace", () => {
  it("`*` with a path outside the workspace ignores the workspace's .gitignore", async () => {
    expect(await run("glob", { pattern: "*", path: mem })).toContain("note.md");
  });

  it("an absolute pattern finds the file (alone, and next to a path)", async () => {
    expect(await run("glob", { pattern: path.join(mem, "*.md") })).toContain("note.md");
    expect(await run("glob", { pattern: path.join(mem, "*") })).toContain("note.md");
    expect(await run("glob", { pattern: path.join(mem, "*.md"), path: mem })).toContain("note.md");
  });

  it("`~` is expanded in the path and in the pattern", async () => {
    expect(await run("glob", { pattern: "*.md", path: "~/.hidden/memory" })).toContain("note.md");
    expect(await run("glob", { pattern: "~/.hidden/memory/*.md" })).toContain("note.md");
  });

  it("a root above a dot-folder sees inside it, and below the workspace-ignored names", async () => {
    const out = await run("glob", { pattern: "**/*.md", path: path.join(tmp, ".hidden") });
    expect(out).toContain("note.md");
    expect(out).toContain("deep.md");
    expect(out).toContain("draft.md");
  });

  it("an outside folder's OWN .gitignore still applies, git or not (QA A6)", async () => {
    const sib = path.join(tmp, "sib");
    fs.mkdirSync(path.join(sib, "src"), { recursive: true });
    fs.mkdirSync(path.join(sib, "node_modules", "pkg"), { recursive: true });
    fs.writeFileSync(path.join(sib, ".gitignore"), "node_modules/\n");
    fs.writeFileSync(path.join(sib, "src", "a.ts"), "const needle = 1;\n");
    fs.writeFileSync(path.join(sib, "node_modules", "pkg", "index.ts"), "const needle = 2;\n");
    const grep = await run("grep", { pattern: "needle", path: sib });
    expect(grep).toContain("a.ts");
    expect(grep).not.toContain("node_modules");
    const glob = await run("glob", { pattern: "**/*.ts", path: sib });
    expect(glob).toContain("a.ts");
    expect(glob).not.toContain("node_modules");
  });

  it("in the workspace, ignored folders and hidden files stay out", async () => {
    const out = await run("glob", { pattern: "**/*.ts" });
    expect(out).toContain("main.ts");
    expect(out).not.toContain("node_modules");
  });
});

describe.runIf(canLock)("one unreadable folder", () => {
  let pws: string;
  beforeAll(() => {
    pws = path.join(tmp, "permws");
    fs.mkdirSync(path.join(pws, "src"), { recursive: true });
    fs.mkdirSync(path.join(pws, "locked"), { recursive: true });
    fs.writeFileSync(path.join(pws, "src", "a.ts"), "const needle = 1;\n");
    fs.chmodSync(path.join(pws, "locked"), 0o000);
  });

  it("glob keeps its matches and says which folder it couldn't read", async () => {
    const out = await run("glob", { pattern: "**/*.ts" }, pws);
    expect(out).toContain("a.ts");
    expect(out).toMatch(/couldn't be read/);
    expect(out).not.toMatch(/Invalid glob pattern|THREW/);
  });

  it("grep keeps its matches and says which folder it couldn't read", async () => {
    const out = await run("grep", { pattern: "needle" }, pws);
    expect(out).toContain("a.ts");
    expect(out).toMatch(/couldn't be read \(permissions\): \.\/locked\./);
    expect(out).not.toMatch(/\n\n\n/);
    expect(out).not.toMatch(/Invalid grep pattern|THREW/);
  });

  it("a real bad pattern is still an error", async () => {
    expect(await run("glob", { pattern: "src/[a" }, pws)).toMatch(/Invalid glob pattern/);
  });
});
