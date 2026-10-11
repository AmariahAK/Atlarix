/**
 * What follows an @ in the box, matched against the folder's files: a name
 * that starts with it first, then one that contains it, then a path that does.
 * Pure, so it is tested without an editor.
 */
export function rankFiles<T extends { label: string }>(files: readonly T[], query: string, limit: number): T[] {
  const q = query.trim().toLowerCase().replace(/\\/g, "/");
  if (!q) return files.slice(0, limit);
  const base = (f: T) => f.label.toLowerCase().replace(/\\/g, "/").split("/").pop() ?? "";
  const scored: Array<{ f: T; score: number }> = [];
  for (const f of files) {
    const name = base(f);
    const full = f.label.toLowerCase().replace(/\\/g, "/");
    const score = name.startsWith(q) ? 0 : name.includes(q) ? 1 : full.includes(q) ? 2 : -1;
    if (score >= 0) scored.push({ f, score });
  }
  scored.sort((a, b) => a.score - b.score || a.f.label.length - b.f.label.length);
  return scored.slice(0, limit).map((x) => x.f);
}
