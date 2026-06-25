/**
 * Ignore rules for Atlarix file discovery + indexing (Blueprint/RTE/glob), via
 * the `ignore` package. Composed from three layers (lowest → highest priority):
 *
 *   1. BUILTIN_IGNORE       — a small, in-memory baseline (dependency/build/cache
 *                             dirs + OS/editor cruft + VCS). Never written to disk;
 *                             covers projects that have no .gitignore.
 *   2. the project .gitignore — the ecosystem-maintained, all-languages source of
 *                             truth (root + .git/info/exclude, PLUS nested
 *                             per-directory .gitignores scoped to their dir, so
 *                             monorepos/multi-repos are covered). We don't
 *                             re-maintain a per-language list; we respect the
 *                             one(s) the repo ships.
 *   3. .atlarix/.atlarixignore — reserved for what the user/AI add for THIS project.
 *
 * `composeIgnoreSource()` concatenates them; everything (glob, Blueprint, RTE,
 * the workspace analyzer) builds its ignorer from that single composed source.
 */

import * as fs from "fs/promises";
import type { Dirent } from "fs";
import * as path from "path";
import ignore from "ignore";
import { ATLARIX_DIR, getAtlarixDirPath } from "@/lib/project-memory";

export const ATLARIX_IGNORE_FILENAME = ".atlarixignore";

/** Workspace-relative path to the ignore file. */
export const ATLARIX_IGNORE_REL = `${ATLARIX_DIR}/${ATLARIX_IGNORE_FILENAME}`;

const LEGACY_ROOT_IGNORE_REL = ATLARIX_IGNORE_FILENAME;

/**
 * In-memory baseline applied to every workspace (NOT written to the user's
 * .atlarixignore). Dependencies, build output, locks, caches, env, large binary
 * data, OS/editor cruft, VCS, and Atlarix internals. The project's own
 * .gitignore layers on top of this for language-specific coverage.
 */
export const BUILTIN_IGNORE = `# Atlarix built-in baseline (gitignore syntax) — composed beneath your .gitignore
node_modules/
**/node_modules/
.pnp/
.pnp.js
.yarn/
dist/
build/
out/
.next/
.nuxt/
.output/
coverage/
.turbo/
.parcel-cache/
.vite/
**/.vite/
.cache/
**/.cache/
*.tsbuildinfo
.next/
.vercel/
storybook-static/
__pycache__/
.venv/
venv/
*.pyc
target/
vendor/bundle/
Pods/
DerivedData/
.gradle/
*.lock
package-lock.json
yarn.lock
pnpm-lock.yaml
bun.lockb
Gemfile.lock
poetry.lock
Pipfile.lock
Cargo.lock
composer.lock
.env
.env.*
!.env.example
*.pem
*.key
*.sqlite
*.db
*.sqlite3
*.parquet
*.arrow
*.csv
*.gz
*.zip
*.tar
*.tgz
*.7z
*.rar
*.iso
*.dmg
*.mp4
*.mov
*.avi
*.mkv
*.wav
*.mp3
*.flac
*.pdf
*.woff
*.woff2
*.ttf
*.eot
*.ico
miniprogram_npm/
.git/
.hg/
.svn/
# OS / editor cruft — noise the agent should never see or index
.DS_Store
**/.DS_Store
Thumbs.db
.vscode/
.idea/
*.swp
*.log
# Repo-scoped Atlarix skills (loaded by Atlarix, hidden from file-tree noise)
.atlarix/skills/
# Generated caches (Atlarix writes these; never index/commit them)
.atlarix/blueprint.json
.atlarix/symbols.json
.atlarix/.ctags-filelist
`;

/**
 * Back-compat alias. Existing projects already have the old big list written to
 * disk; new projects get the minimal template below. Both compose fine.
 * @deprecated prefer BUILTIN_IGNORE (baseline) + composeIgnoreSource().
 */
export const DEFAULT_ATLARIXIGNORE = BUILTIN_IGNORE;

/**
 * What `ensureDefaultAtlarixIgnore` writes to a NEW project's .atlarixignore.
 * Intentionally minimal: the baseline + the repo's .gitignore already cover the
 * common cases, so this file is just the user's/AI's project-specific layer.
 */
export const ATLARIXIGNORE_FILE_TEMPLATE = `# .atlarixignore — project-specific excludes for Atlarix (gitignore syntax).
#
# Atlarix already ignores your .gitignore plus a built-in baseline of common
# dependency/build/cache directories and OS/editor cruft. Add paths here that
# ONLY Atlarix should skip — e.g. large fixtures, generated docs, vendored code
# you still want git to track. One pattern per line.
`;

export type AtlarixIgnoreInstance = ReturnType<typeof ignore>;

export function createIgnorerFromSource(source: string): AtlarixIgnoreInstance {
  return ignore().add(source);
}

/** Normalize to repo-relative forward-slash path for matching. */
export function normalizeRelPath(projectRoot: string, filePath: string): string {
  const normRoot = path.normalize(projectRoot).replace(/\\/g, "/");
  let p = path.normalize(filePath).replace(/\\/g, "/");
  if (path.isAbsolute(filePath)) {
    if (p.startsWith(normRoot)) {
      p = path.relative(projectRoot, filePath).replace(/\\/g, "/");
    }
  }
  return p.replace(/^\.\//, "");
}

export function isRelPathIgnored(ig: AtlarixIgnoreInstance, relPath: string): boolean {
  if (!relPath) return false;
  const p = relPath.replace(/\\/g, "/").replace(/^\.\//, "");
  return ig.ignores(p);
}

export function getAtlarixIgnorePath(projectRoot: string): string {
  return path.join(projectRoot, ATLARIX_IGNORE_REL);
}

function legacyRootAtlarixIgnorePath(projectRoot: string): string {
  return path.join(projectRoot, LEGACY_ROOT_IGNORE_REL);
}

async function migrateLegacyAtlarixIgnore(projectRoot: string): Promise<void> {
  const canonical = getAtlarixIgnorePath(projectRoot);
  const legacy = legacyRootAtlarixIgnorePath(projectRoot);
  try {
    await fs.access(canonical);
    return;
  } catch {
    /* migrate or create */
  }
  await fs.mkdir(getAtlarixDirPath(projectRoot), { recursive: true });
  const legacyContent = await fs.readFile(legacy, "utf-8").catch(() => null);
  if (legacyContent?.trim()) {
    await fs.writeFile(canonical, legacyContent, "utf-8");
    try {
      await fs.rename(legacy, `${legacy}.old`);
    } catch {
      /* non-fatal */
    }
    return;
  }
}

export async function readAtlarixIgnoreSource(projectRoot: string): Promise<string> {
  await migrateLegacyAtlarixIgnore(projectRoot);
  const fp = getAtlarixIgnorePath(projectRoot);
  try {
    return await fs.readFile(fp, "utf-8");
  } catch {
    return "";
  }
}

/**
 * The project's ROOT ignore rules — its root `.gitignore` plus the local-only
 * `.git/info/exclude`. This is the ecosystem-maintained, all-languages source we
 * respect instead of hand-maintaining a per-language list. Nested per-directory
 * `.gitignore` files (monorepo packages, multi-repo sub-projects) are collected
 * separately and scoped by `collectNestedGitignores`.
 */
export async function readGitignoreSource(projectRoot: string): Promise<string> {
  const candidates = [
    path.join(projectRoot, ".gitignore"),
    path.join(projectRoot, ".git", "info", "exclude"),
  ];
  const parts: string[] = [];
  for (const fp of candidates) {
    try {
      const src = await fs.readFile(fp, "utf-8");
      if (src.trim()) parts.push(src);
    } catch {
      /* absent — fine */
    }
  }
  return parts.join("\n");
}

// Directories never descended into when discovering nested .gitignore files
// (and never walked for matches). Keeps the walk cheap on big trees.
const NESTED_WALK_PRUNE = new Set([
  "node_modules", ".git", "dist", "build", "out", "coverage",
  ".next", ".nuxt", ".cache", ".turbo", ".venv", "venv",
  "__pycache__", "vendor", "Pods", "DerivedData", ".gradle", "target",
]);
const NESTED_WALK_MAX_DEPTH = 6;
const NESTED_WALK_MAX_FILES = 200;

/**
 * Rewrite one nested `.gitignore` so its patterns are anchored under `dirRel`
 * (its directory, repo-relative, forward-slash). Mirrors git's rule: a pattern
 * with a slash at the start/middle is anchored to the .gitignore's dir; a
 * slash-less pattern matches at any depth below it (prefixed with the dir plus a
 * globstar). Negation (`!`) and trailing-slash (dir-only) semantics are preserved.
 */
export function scopeGitignoreToDir(source: string, dirRel: string): string {
  const out: string[] = [];
  for (const raw of source.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    let neg = "";
    let body = line;
    if (body.startsWith("!")) {
      neg = "!";
      body = body.slice(1);
    }
    const core = body.endsWith("/") ? body.slice(0, -1) : body;
    const anchored = core.includes("/"); // slash at start or middle → anchored
    if (body.startsWith("/")) body = body.slice(1);
    const prefix = `${dirRel}/`;
    out.push(`${neg}${anchored ? prefix + body : `${prefix}**/${body}`}`);
  }
  return out.length ? `# --- ${dirRel}/.gitignore ---\n${out.join("\n")}` : "";
}

/**
 * Walk the tree (depth- and count-bounded, pruning heavy dirs) collecting every
 * NESTED `.gitignore` — so monorepo packages and multi-repo sub-projects each
 * contribute their own scoped rules. The ROOT .gitignore is handled separately
 * (unscoped) by readGitignoreSource. Nested per-repo `.git/info/exclude` is not
 * collected (rare); the tracked nested `.gitignore` covers the common case.
 */
export async function collectNestedGitignores(projectRoot: string): Promise<string> {
  const blocks: string[] = [];
  let found = 0;

  async function walk(absDir: string, relDir: string, depth: number): Promise<void> {
    if (depth > NESTED_WALK_MAX_DEPTH || found >= NESTED_WALK_MAX_FILES) return;
    let entries: Dirent[];
    try {
      entries = await fs.readdir(absDir, { withFileTypes: true });
    } catch {
      return;
    }
    if (relDir) {
      const hasGitignore = entries.some((e) => e.isFile() && e.name === ".gitignore");
      if (hasGitignore) {
        try {
          const src = await fs.readFile(path.join(absDir, ".gitignore"), "utf-8");
          const scoped = scopeGitignoreToDir(src, relDir);
          if (scoped) {
            blocks.push(scoped);
            found += 1;
          }
        } catch {
          /* unreadable — skip */
        }
      }
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      // Skip pruned dirs and any dot-directory (.git, .vscode, …) — nested
      // package gitignores live in normal dirs (packages/*, apps/*).
      if (NESTED_WALK_PRUNE.has(e.name) || e.name.startsWith(".")) continue;
      await walk(
        path.join(absDir, e.name),
        relDir ? `${relDir}/${e.name}` : e.name,
        depth + 1,
      );
    }
  }

  await walk(projectRoot, "", 0);
  return blocks.join("\n");
}

/**
 * The single effective ignore source, lowest → highest priority:
 *   BUILTIN_IGNORE  ∪  root .gitignore (+info/exclude)  ∪  nested .gitignores
 *   (scoped, for monorepos/multi-repos)  ∪  .atlarixignore.
 * Later layers can negate earlier ones with `!`. Used both to build the ignorer
 * and as the Blueprint cache key, so a change to ANY layer re-indexes.
 */
export async function composeIgnoreSource(projectRoot: string): Promise<string> {
  const layers = [BUILTIN_IGNORE];
  const git = await readGitignoreSource(projectRoot);
  if (git.trim()) layers.push(`# --- project .gitignore ---\n${git}`);
  const nested = await collectNestedGitignores(projectRoot);
  if (nested.trim()) layers.push(nested);
  const atlarix = await readAtlarixIgnoreSource(projectRoot);
  if (atlarix.trim()) layers.push(`# --- .atlarixignore ---\n${atlarix}`);
  return layers.join("\n");
}

/**
 * Create a minimal `.atlarix/.atlarixignore` if missing. The heavy lifting lives
 * in BUILTIN_IGNORE (in-memory) + the project's .gitignore, so this file starts
 * essentially empty for the user/AI to add project-specific excludes.
 */
export async function ensureDefaultAtlarixIgnore(projectRoot: string): Promise<void> {
  await migrateLegacyAtlarixIgnore(projectRoot);
  const fp = getAtlarixIgnorePath(projectRoot);
  try {
    await fs.access(fp);
  } catch {
    try {
      await fs.mkdir(getAtlarixDirPath(projectRoot), { recursive: true });
      await fs.writeFile(fp, ATLARIXIGNORE_FILE_TEMPLATE, "utf-8");
    } catch {
      /* non-fatal */
    }
  }
}

/** Async: the composed ignorer (baseline ∪ .gitignore ∪ .atlarixignore). */
export async function loadIgnorerForProject(projectRoot: string): Promise<AtlarixIgnoreInstance> {
  return createIgnorerFromSource(await composeIgnoreSource(projectRoot));
}


export interface BlueprintNodeLike {
  id: string;
  file: string;
}

export function filterRteNodesByIgnore<T extends BlueprintNodeLike>(
  nodes: T[],
  ig: AtlarixIgnoreInstance,
  projectRoot: string,
): T[] {
  return nodes.filter((n) => {
    const rel = normalizeRelPath(projectRoot, n.file);
    if (!rel) return true;
    return !isRelPathIgnored(ig, rel);
  });
}

export function filterRteEdgesByNodes<T extends { from: string; to: string }>(
  edges: T[],
  keptNodeIds: Set<string>,
): T[] {
  return edges.filter((e) => keptNodeIds.has(e.from) && keptNodeIds.has(e.to));
}
