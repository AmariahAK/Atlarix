/**
 * The one file-listing engine, over a real temp workspace and the real bundled
 * ripgrep — no mocks. Every assertion here is a property the old three-strategy
 * discovery path got wrong for somebody.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  listWorkspaceFiles,
  searchWorkspaceFiles,
  listWorkspaceFilesUnder,
} from "@/ipc/utils/workspace-file-list";

let ws: string;

function write(rel: string, content = "x") {
  const abs = path.join(ws, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

beforeAll(() => {
  ws = fs.mkdtempSync(path.join(os.tmpdir(), "atlarix-file-list-"));
  write(".gitignore", "node_modules/\ncdk.out/\n.env\n");
  write("real.ts");
  write("README.md");
  write(".env", "SECRET=1");
  write(".github/workflows/ci.yml");
  write("src/components/chat/Composer.tsx");
  write("src/components/chat/Message.tsx");
  write("src/lib/utils.ts");
  write("packages/api/server.ts");
  write("packages/api/nested/deep.ts");
  write("node_modules/pkg/index.js");
  write("cdk.out/asset.abc/thing.js");
  write(`cdk.out/${"a".repeat(64)}/hashed.js`);
  // A real .git directory is what forces the one exclusion we kept.
  write(".git/config", "[core]\n");
  write(".git/objects/ab/cdef", "blob");
});

afterAll(() => {
  fs.rmSync(ws, { recursive: true, force: true });
});

describe("listWorkspaceFiles", () => {
  it("honours .gitignore, which is what made the hardcoded exclusion list redundant", async () => {
    const files = await listWorkspaceFiles(ws);
    expect(files).toContain("real.ts");
    expect(files.some((f) => f.startsWith("node_modules/"))).toBe(false);
    // cdk.out, `asset.*` and the 64-hex segment rule were three hand-maintained
    // entries covering what one gitignore line already covers.
    expect(files.some((f) => f.startsWith("cdk.out/"))).toBe(false);
  });

  it("lists dotfiles — @-mention has always reached .github/workflows", async () => {
    const files = await listWorkspaceFiles(ws);
    expect(files).toContain(".github/workflows/ci.yml");
    expect(files).toContain(".gitignore");
  });

  it("excludes .git/**, the only exclusion that survived", async () => {
    const files = await listWorkspaceFiles(ws);
    expect(files.some((f) => f.startsWith(".git/"))).toBe(false);
  });

  it("respects a gitignored .env", async () => {
    // Not a secret denylist — `.env` is here because this fixture's .gitignore
    // lists it. An in-workspace, non-ignored .env is still enumerable.
    const files = await listWorkspaceFiles(ws);
    expect(files).not.toContain(".env");
  });

  it("returns a stable order across runs", async () => {
    // ripgrep's parallel walkers do not emit a stable order. Unsorted, the `@`
    // menu would reshuffle between keystrokes now that every query is its own
    // run — invisible before, when the list was built once and cached 5 minutes.
    const a = await listWorkspaceFiles(ws);
    const b = await listWorkspaceFiles(ws);
    expect(a).toEqual(b);
  });

  it("leads with real content, not dotfiles", async () => {
    // The regression a plain `.sort()` shipped: `@` opened on `.cargo/`,
    // `.github/`, `.cargo/audit.toml`… with the repo's actual contents below the
    // fold. Deterministic and useless.
    const files = await listWorkspaceFiles(ws);
    const firstVisible = files.findIndex(
      (f) => !f.split("/").some((s) => s.startsWith(".")),
    );
    const firstHidden = files.findIndex((f) =>
      f.split("/").some((s) => s.startsWith(".")),
    );
    expect(firstVisible).toBeLessThan(firstHidden);
    expect(files[0]).toBe("README.md");
  });

  it("puts shallower paths first — a root file beats a deeply nested one", async () => {
    const files = await listWorkspaceFiles(ws);
    expect(files.indexOf("real.ts")).toBeLessThan(
      files.indexOf("packages/api/nested/deep.ts"),
    );
  });

  it("still finds hidden files when you type for them", async () => {
    // Ordering them last must not make them unreachable.
    const hits = await searchWorkspaceFiles(ws, ".github");
    expect(hits).toContain(".github/workflows/ci.yml");
  });

  it("returns [] for a missing workspace instead of throwing", async () => {
    expect(await listWorkspaceFiles(path.join(ws, "does-not-exist"))).toEqual(
      [],
    );
    expect(await listWorkspaceFiles("")).toEqual([]);
  });
});

describe("searchWorkspaceFiles", () => {
  it("matches a substring of the WHOLE relative path, not just the basename", async () => {
    // The regression an `--iglob "*q*"` implementation would have shipped:
    // ripgrep globs without a `/` match the basename only, so `chat` would have
    // missed every file under `src/components/chat/`. Measured on the real repo
    // when this was designed: 60 hits vs 209.
    const hits = await searchWorkspaceFiles(ws, "chat");
    expect(hits).toContain("src/components/chat/Composer.tsx");
    expect(hits).toContain("src/components/chat/Message.tsx");
  });

  it("is case-insensitive, like the composer filter it replaces", async () => {
    expect(await searchWorkspaceFiles(ws, "COMPOSER")).toContain(
      "src/components/chat/Composer.tsx",
    );
  });

  it("returns everything for an empty query", async () => {
    const all = await listWorkspaceFiles(ws);
    expect(await searchWorkspaceFiles(ws, "")).toEqual(all);
    expect(await searchWorkspaceFiles(ws, "   ")).toEqual(all);
  });

  it("caps the RESULT, never the corpus", async () => {
    // The old MENTION_PATHS_LIMIT truncated the list before searching it, so on
    // a repo past the cap the tail was unmentionable however you spelled it.
    // A limit here must not hide a file from a later, narrower query.
    const capped = await searchWorkspaceFiles(ws, "", 2);
    expect(capped).toHaveLength(2);
    expect(await searchWorkspaceFiles(ws, "deep.ts")).toContain(
      "packages/api/nested/deep.ts",
    );
  });
});

describe("listWorkspaceFilesUnder", () => {
  it("scopes to a folder and returns paths relative to it", async () => {
    const under = await listWorkspaceFilesUnder(ws, "packages/api");
    expect(under.sort()).toEqual(["nested/deep.ts", "server.ts"]);
  });

  it("tolerates trailing and leading slashes", async () => {
    expect(await listWorkspaceFilesUnder(ws, "packages/api/")).toContain(
      "server.ts",
    );
    expect(await listWorkspaceFilesUnder(ws, "./packages/api")).toContain(
      "server.ts",
    );
  });

  it("still applies the workspace's own .gitignore when scoped", async () => {
    // Scoping prefix-filters a root enumeration rather than moving ripgrep's cwd
    // into the subdirectory: .gitignore patterns resolve relative to the ignore
    // file's directory, so a subdirectory cwd would mis-apply every one of them.
    expect(await listWorkspaceFilesUnder(ws, "node_modules")).toEqual([]);
  });

  it("returns the whole workspace for an empty scope", async () => {
    expect(await listWorkspaceFilesUnder(ws, "")).toEqual(
      await listWorkspaceFiles(ws),
    );
  });
});
