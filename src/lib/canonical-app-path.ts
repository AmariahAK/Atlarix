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
import path from "node:path";

/** Absolute, separator-normalized, trailing-slash-stripped; case-folded on macOS/Windows. */
export function normalizeAppPath(p: string | null | undefined): string {
  if (!p || !p.trim()) return "";
  let out = path.resolve(p.trim()).replace(/[\\/]+$/, "");
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
