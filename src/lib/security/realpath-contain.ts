/**
 * Symlink-aware workspace containment.
 *
 * String-level path checks (reject `..`/absolute) don't catch a symlink that
 * lives INSIDE the workspace but points OUTSIDE it — `fs.readFile` happily
 * follows it and returns the out-of-workspace target. This realpath check closes
 * that gap. Extracted from PermissionInterceptor (which used it only for writes)
 * so `read_file` (and other readers) can reuse the exact same, tested logic.
 *
 * Fail-OPEN on any realpath error (unresolvable root/target) — mirrors the
 * interceptor's original behavior, so this never introduces NEW rejections for
 * paths that simply can't be canonicalized.
 */

import { realpathSync } from "node:fs";
import * as path from "node:path";

/** Throw when the real (symlink-resolved) target escapes the workspace + allowed roots. */
export function assertRealpathContained(
  resolved: string,
  workspace: string,
  allowedRoots: readonly string[],
  original: string,
): void {
  let realWorkspace: string;
  try {
    realWorkspace = realpathSync(workspace);
  } catch {
    return; // can't canonicalize the root — fail open (no new rejections)
  }
  const realAllowed: string[] = [];
  for (const root of allowedRoots) {
    try {
      realAllowed.push(realpathSync(root));
    } catch {
      /* skip unresolvable roots */
    }
  }
  // The target may not exist yet (a write) — realpath the nearest existing
  // ancestor, then re-append the not-yet-existing suffix.
  let probe = resolved;
  let realAncestor: string;
  for (;;) {
    try {
      realAncestor = realpathSync(probe);
      break;
    } catch {
      const parent = path.dirname(probe);
      if (parent === probe) return; // no existing ancestor — nothing to check
      probe = parent;
    }
  }
  const realTarget = path.resolve(realAncestor, path.relative(probe, resolved));
  const contained = (root: string): boolean => {
    const rel = path.relative(root, realTarget);
    return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
  };
  if (contained(realWorkspace) || realAllowed.some(contained)) return;
  throw new Error(
    `Path escapes the workspace via a symlink: ${original}. Refusing to operate outside the project.`,
  );
}
