/**
 * Sub-package boundary detection for monorepo / multi-repo workspaces.
 *
 * Walks the workspace directory tree (skipping vendor/build dirs) for package
 * markers — `package.json`, `go.mod`, `Cargo.toml`, `pyproject.toml`, and nested
 * `.git` (multi-repo) — and maps each workspace-relative file to its NEAREST
 * enclosing package root (posix, relative to the workspace). Files under no
 * sub-package map to `"."` (the workspace root itself).
 *
 * Used by `fts5-index.ts` to fill the `package` column so lexical/semantic
 * queries can be scoped to the active package on big monorepos — workspace
 * agnostic: everything is keyed off the marker files actually present.
 */

import * as fsp from "node:fs/promises";
import path from "node:path";

/** Files whose presence marks a directory as a package root. */
const PACKAGE_MARKERS = new Set([
  "package.json",
  "go.mod",
  "Cargo.toml",
  "pyproject.toml",
  ".git", // nested repo / submodule → its own package (multi-repo workspaces)
]);

/** Directories never worth descending into when locating package roots. */
const SKIP_DIRS = new Set([
  "node_modules", ".git", "dist", "build", "out", ".next", ".nuxt",
  "target", "vendor", ".venv", "venv", "__pycache__", ".turbo", ".cache",
  "coverage", ".gradle", "bin", "obj", ".idea", ".vscode",
]);

/** Bound the walk so a pathological tree can't stall indexing. */
const MAX_WALK_DEPTH = 8;
const MAX_DIRS_SCANNED = 20_000;

export interface PackageMap {
  /** Package root dirs (workspace-relative, posix), always including `"."`. */
  roots: string[];
  /** Nearest enclosing package root for a workspace-relative file path. */
  packageFor(relPath: string): string;
}

function toPosix(p: string): string {
  return p.replace(/\\/g, "/");
}

/**
 * Discover package roots under `workspaceRootAbs`. Always includes `"."`. The
 * walk is directory-only (it never enumerates files), so it stays cheap even on
 * huge repos.
 */
export async function detectPackages(
  workspaceRootAbs: string,
): Promise<PackageMap> {
  const roots = new Set<string>(["."]);
  let scanned = 0;

  async function walk(absDir: string, relDir: string, depth: number): Promise<void> {
    if (depth > MAX_WALK_DEPTH || scanned >= MAX_DIRS_SCANNED) return;
    scanned++;

    let entries: import("node:fs").Dirent[];
    try {
      entries = await fsp.readdir(absDir, { withFileTypes: true });
    } catch {
      return;
    }

    // A directory is a package root if it holds any marker (besides the
    // workspace root, which is always "." and already present).
    for (const e of entries) {
      if (PACKAGE_MARKERS.has(e.name) && relDir !== ".") {
        roots.add(relDir);
        break;
      }
    }

    for (const e of entries) {
      if (!e.isDirectory() || SKIP_DIRS.has(e.name) || e.name.startsWith(".")) {
        continue;
      }
      const childRel = relDir === "." ? e.name : `${relDir}/${e.name}`;
      await walk(path.join(absDir, e.name), childRel, depth + 1);
    }
  }

  await walk(workspaceRootAbs, ".", 0);

  // Longest root first so `packageFor` picks the most specific enclosing package.
  const sorted = [...roots].sort((a, b) => b.length - a.length);

  return {
    roots: [...roots].sort(),
    packageFor(relPath: string): string {
      const rel = toPosix(relPath);
      for (const root of sorted) {
        if (root === ".") continue;
        if (rel === root || rel.startsWith(`${root}/`)) return root;
      }
      return ".";
    },
  };
}
