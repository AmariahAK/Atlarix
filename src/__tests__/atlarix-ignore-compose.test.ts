import { describe, expect, it, beforeAll, afterAll } from "vitest";
import * as os from "os";
import * as path from "path";
import * as fs from "fs/promises";
import {
  composeIgnoreSource,
  loadIgnorerForProject,
  isRelPathIgnored,
  ensureDefaultAtlarixIgnore,
  getAtlarixIgnorePath,
  scopeGitignoreToDir,
} from "@/lib/atlarix/atlarix-ignore";

/**
 * v13.8: the ignorer is composed from three layers —
 *   BUILTIN_IGNORE  ∪  the project's .gitignore  ∪  .atlarix/.atlarixignore
 * so we no longer hand-maintain a per-language list (the repo's .gitignore is
 * the source of truth) and .atlarixignore is reserved for project-specific adds.
 */
describe("atlarix-ignore composed source", () => {
  let dir: string;

  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "atlarix-ignore-"));
    // Project .gitignore — the ecosystem-maintained, all-languages source.
    await fs.writeFile(
      path.join(dir, ".gitignore"),
      "build_artifacts/\n*.generated.ts\n",
      "utf-8",
    );
    // Project-specific Atlarix layer.
    await fs.mkdir(path.join(dir, ".atlarix"), { recursive: true });
    await fs.writeFile(
      path.join(dir, ".atlarix", ".atlarixignore"),
      "fixtures/huge/\n",
      "utf-8",
    );
  });

  afterAll(async () => {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  });

  it("applies the built-in baseline even without any project files", async () => {
    const bare = await fs.mkdtemp(path.join(os.tmpdir(), "atlarix-bare-"));
    try {
      const ig = await loadIgnorerForProject(bare);
      // Dependency dir + OS cruft are ignored from the in-memory baseline.
      expect(isRelPathIgnored(ig, "node_modules/react/index.js")).toBe(true);
      expect(isRelPathIgnored(ig, ".DS_Store")).toBe(true);
      expect(isRelPathIgnored(ig, "src/sub/.DS_Store")).toBe(true);
      expect(isRelPathIgnored(ig, ".vscode/settings.json")).toBe(true);
      // Real source is kept.
      expect(isRelPathIgnored(ig, "src/index.ts")).toBe(false);
    } finally {
      await fs.rm(bare, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("ignores generated .atlarix caches but keeps user-facing .atlarix docs (P4)", async () => {
    const ig = await loadIgnorerForProject(dir);
    // Generated caches Atlarix writes — never index/commit.
    expect(isRelPathIgnored(ig, ".atlarix/symbols.json")).toBe(true);
    expect(isRelPathIgnored(ig, ".atlarix/blueprint.json")).toBe(true);
    expect(isRelPathIgnored(ig, ".atlarix/.ctags-filelist")).toBe(true);
    // User-facing project docs stay tracked.
    expect(isRelPathIgnored(ig, ".atlarix/memory.md")).toBe(false);
    expect(isRelPathIgnored(ig, ".atlarix/atlarix.md")).toBe(false);
  });

  it("hides IDE/VCS folders from a Code-tab style file list (built-in + .gitignore)", async () => {
    // Mirrors the loadAppFileIndex filter: a flat discovery list run through the
    // project ignorer drops .git/.vscode/.idea + .gitignored, keeps real source.
    const ig = await loadIgnorerForProject(dir);
    const discovered = [
      ".git/HEAD",
      ".vscode/settings.json",
      ".idea/workspace.xml",
      "node_modules/react/index.js",
      "build_artifacts/out.js", // from this project's .gitignore
      "src/index.ts",
      "README.md",
    ];
    const visible = discovered.filter((f) => !isRelPathIgnored(ig, f));
    expect(visible).toEqual(["src/index.ts", "README.md"]);
  });

  it("respects the project's own .gitignore", async () => {
    const ig = await loadIgnorerForProject(dir);
    expect(isRelPathIgnored(ig, "build_artifacts/out.js")).toBe(true);
    expect(isRelPathIgnored(ig, "src/widget.generated.ts")).toBe(true);
    expect(isRelPathIgnored(ig, "src/widget.ts")).toBe(false);
  });

  it("layers .atlarixignore on top for project-specific excludes", async () => {
    const ig = await loadIgnorerForProject(dir);
    expect(isRelPathIgnored(ig, "fixtures/huge/data.bin")).toBe(true);
  });

  it("composeIgnoreSource concatenates all three layers", async () => {
    const src = await composeIgnoreSource(dir);
    expect(src).toContain("node_modules/"); // baseline
    expect(src).toContain("build_artifacts/"); // .gitignore
    expect(src).toContain("fixtures/huge/"); // .atlarixignore
  });

  it("scopes nested .gitignore to its own directory (monorepo/multi-repo)", async () => {
    const mono = await fs.mkdtemp(path.join(os.tmpdir(), "atlarix-mono-"));
    try {
      // packages/api ignores its own `generated/`; packages/web ignores `.tmp`.
      await fs.mkdir(path.join(mono, "packages", "api"), { recursive: true });
      await fs.mkdir(path.join(mono, "packages", "web"), { recursive: true });
      await fs.writeFile(
        path.join(mono, "packages", "api", ".gitignore"),
        "generated/\n",
        "utf-8",
      );
      await fs.writeFile(
        path.join(mono, "packages", "web", ".gitignore"),
        "*.tmp\n",
        "utf-8",
      );

      const ig = await loadIgnorerForProject(mono);
      // Each package's rule applies only under that package…
      expect(isRelPathIgnored(ig, "packages/api/generated/client.ts")).toBe(true);
      expect(isRelPathIgnored(ig, "packages/web/scratch.tmp")).toBe(true);
      // …and does NOT leak to siblings or the root.
      expect(isRelPathIgnored(ig, "packages/web/generated/x.ts")).toBe(false);
      expect(isRelPathIgnored(ig, "generated/x.ts")).toBe(false);
      expect(isRelPathIgnored(ig, "packages/api/src/index.ts")).toBe(false);
    } finally {
      await fs.rm(mono, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("scopeGitignoreToDir anchors vs floats patterns like git", () => {
    const scoped = scopeGitignoreToDir("/anchored\nfloating\nsub/dir\n", "pkg/a");
    expect(scoped).toContain("pkg/a/anchored"); // leading slash → anchored to dir
    expect(scoped).toContain("pkg/a/**/floating"); // no slash → any depth below
    expect(scoped).toContain("pkg/a/sub/dir"); // middle slash → anchored
  });

  it("writes a minimal .atlarixignore template (not the big list)", async () => {
    const fresh = await fs.mkdtemp(path.join(os.tmpdir(), "atlarix-fresh-"));
    try {
      await ensureDefaultAtlarixIgnore(fresh);
      const written = await fs.readFile(getAtlarixIgnorePath(fresh), "utf-8");
      // Project-specific layer only — the baseline is in-memory, not dumped here.
      expect(written).not.toContain("node_modules/");
      expect(written).toContain("project-specific excludes");
    } finally {
      await fs.rm(fresh, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("ensureDefaultAtlarixIgnore is idempotent — second call is a no-op, no churn (P2)", async () => {
    const fresh = await fs.mkdtemp(path.join(os.tmpdir(), "atlarix-idem-"));
    try {
      await ensureDefaultAtlarixIgnore(fresh);
      const canonical = getAtlarixIgnorePath(fresh);
      // Mark the file so we can prove the 2nd call doesn't overwrite/recreate it.
      await fs.writeFile(canonical, "# user edited\n", "utf-8");
      await ensureDefaultAtlarixIgnore(fresh);
      expect(await fs.readFile(canonical, "utf-8")).toBe("# user edited\n");
      // No `.old` archive is produced when the canonical file already exists.
      await expect(
        fs.access(path.join(fresh, ".atlarixignore.old")),
      ).rejects.toBeTruthy();
    } finally {
      await fs.rm(fresh, { recursive: true, force: true }).catch(() => {});
    }
  });
});
