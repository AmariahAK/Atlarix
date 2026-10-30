/**
 * A sha256 for every file in a plugin folder, keyed by POSIX relative path.
 *
 * This is what "verified on every load" means: the install record keeps this map,
 * and each load recomputes it and compares the two whole. A changed, added or
 * removed file turns the plugin off. Checking the commit SHA alone would prove
 * what was downloaded, not what is on disk now.
 *
 * Content, never mtime or size: `touch -r` keeps a timestamp, and a same-length
 * edit keeps a size.
 *
 * A SYMLINK ANYWHERE IS REFUSED. A link inside the folder can point at a file the
 * hash never sees, which then changes underneath an unchanged tree. There is no
 * legitimate plugin shape that needs one.
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export type TreeHashes = Record<string, string>;

export class PluginTreeError extends Error {}

/** Folders a download or checkout may carry that are not part of the plugin. */
const SKIPPED_DIRS = new Set([".git"]);

export function hashTree(root: string): TreeHashes {
  const out: TreeHashes = {};
  const walk = (dir: string, rel: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;
      const abs = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        throw new PluginTreeError(
          `${relPath} is a link; plugins can't contain links`,
        );
      }
      if (entry.isDirectory()) {
        // Only the plugin's own top-level `.git` (a clone's); one deeper is content.
        if (!rel && SKIPPED_DIRS.has(entry.name)) continue;
        walk(abs, relPath);
      } else if (entry.isFile()) {
        out[relPath] = createHash("sha256")
          .update(fs.readFileSync(abs))
          .digest("hex");
      } else {
        // A FIFO, socket or device would never hash, so it could never be checked.
        throw new PluginTreeError(`${relPath} is not a regular file`);
      }
    }
  };
  walk(root, "");
  return out;
}

/** The relative paths that differ between two hash maps, sorted. Empty = same tree. */
export function diffTrees(expected: TreeHashes, actual: TreeHashes): string[] {
  const changed = new Set<string>();
  for (const [p, h] of Object.entries(expected)) {
    if (actual[p] !== h) changed.add(p);
  }
  for (const p of Object.keys(actual)) {
    if (!(p in expected)) changed.add(p);
  }
  return [...changed].sort();
}

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}
