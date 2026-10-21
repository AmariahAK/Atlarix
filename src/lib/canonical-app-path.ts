/**
 * Canonical workspace-path normalization (Bug 5).
 *
 * Two `apps` rows can exist for the "same" folder when the stored path differs
 * only by representation (trailing slash, separators, `..`, or case on
 * case-insensitive filesystems). Permission rules then land on one row while the
 * chat enforces under another. A single normalization — used by the merge
 * routine, the canonical resolver, and any path comparison — is the only thing
 * that keeps the write and read sides agreeing. Keep this the ONLY implementation.
 */
import fs from "node:fs";
import path from "node:path";

/**
 * The path with its symlinks resolved: `/tmp/x` is `/private/tmp/x` on macOS, a
 * symlinked `~/code` is where it points. Without this one folder opened through
 * two spellings was two workspaces (E13: VS Code's `/tmp/x` and the CLI's
 * `process.cwd()`, which the OS resolves, split the sessions in two). A part
 * that does not exist yet (a file about to be written) keeps its own name under
 * its nearest existing parent, resolved, so both sides of a comparison agree.
 */
export function realAppPath(p: string): string {
  const abs = path.resolve(p);
  let head = abs;
  const rest: string[] = [];
  for (;;) {
    try {
      return path.join(fs.realpathSync.native(head), ...rest.reverse());
    } catch {
      const parent = path.dirname(head);
      if (parent === head) return abs;
      rest.push(path.basename(head));
      head = parent;
    }
  }
}

/** Absolute, symlinks resolved, separator-normalized, trailing-slash-stripped; case-folded on macOS/Windows. */
export function normalizeAppPath(p: string | null | undefined): string {
  if (!p || !p.trim()) return "";
  let out = realAppPath(p.trim()).replace(/[\\/]+$/, "");
  if (process.platform === "darwin" || process.platform === "win32") {
    out = out.toLowerCase();
  }
  return out;
}

/**
 * Group app rows that share a normalized path and have more than one row.
 * Each returned group is ascending by id, so `group[0]` is the oldest =
 * canonical row to keep; the rest are duplicates to merge into it.
 */
export function groupDuplicateAppIds(
  rows: Array<{ id: number; path: string }>,
): number[][] {
  const groups = new Map<string, number[]>();
  for (const r of [...rows].sort((a, b) => a.id - b.id)) {
    const key = normalizeAppPath(r.path);
    if (!key) continue;
    const arr = groups.get(key) ?? [];
    arr.push(r.id);
    groups.set(key, arr);
  }
  return [...groups.values()].filter((ids) => ids.length > 1);
}
