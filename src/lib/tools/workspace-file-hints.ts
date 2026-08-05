import { listWorkspaceFiles } from "@/ipc/utils/workspace-file-list";

/** Repos at or below this size get an explicit path list in tool errors and delegation prompts. */
export const SMALL_REPO_FILE_THRESHOLD = 30;

export async function getWorkspaceRelFilePaths(
  workspacePath: string,
): Promise<{ paths: string[]; count: number }> {
  const files = await listWorkspaceFiles(workspacePath);
  return { paths: files, count: files.length };
}

export function formatSmallRepoInventory(paths: string[]): string {
  if (paths.length === 0) {
    return (
      "No tracked files were discovered in this workspace (empty git index or wrong folder). " +
      "Use explore_folder on \".\" or list_files before guessing paths."
    );
  }
  const quoted = paths.map((p) => `"${p}"`).join(", ");
  return (
    `This workspace has only ${paths.length} tracked file(s): ${quoted}. ` +
    "Read or search **only** those paths. Do not probe package.json, tsconfig.json, LICENSE, Dockerfile, or other conventional root files unless they appear in this list. " +
    "Never pass absolute paths (e.g. /Users/...); use workspace-relative paths only."
  );
}

export function isDirectoryReadPath(filePath: string): boolean {
  const norm = filePath.replace(/\\/g, "/").trim();
  return norm === "" || norm === "." || norm === "./";
}

function normalizeRel(p: string): string {
  return p.replace(/\\/g, "/").replace(/^\.\//, "").trim();
}

function basenameOf(p: string): string {
  const i = p.lastIndexOf("/");
  return i >= 0 ? p.slice(i + 1) : p;
}

function extOf(base: string): string {
  const i = base.lastIndexOf(".");
  return i > 0 ? base.slice(i) : "";
}

/** Levenshtein distance, early-exiting once the running minimum exceeds `max`. */
function boundedLevenshtein(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  if (a === b) return 0;
  const prev: number[] = Array.from({ length: b.length + 1 }, () => 0);
  const curr: number[] = Array.from({ length: b.length + 1 }, () => 0);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    let rowMin = curr[0]!;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j]! + 1, curr[j - 1]! + 1, prev[j - 1]! + cost);
      if (curr[j]! < rowMin) rowMin = curr[j]!;
    }
    if (rowMin > max) return max + 1; // whole remaining rows can only grow
    for (let j = 0; j <= b.length; j++) prev[j] = curr[j]!;
  }
  return prev[b.length]!;
}

/**
 * "Did you mean …?" suggestion for a path that doesn't exist — the rename/typo
 * recovery the model needs after e.g. moving a file. Backed by a LIVE ripgrep
 * listing (no index, no cache): this helper's whole job is answering a miss that
 * a rename just caused, and the discovery cache it used to read was 5 minutes
 * stale, so it could suggest the very name that had just stopped existing.
 * Returns null when the path exists, the workspace is empty, or nothing is
 * close. Cheap: only called on a tool FAILURE.
 */
export async function suggestClosestPath(
  workspacePath: string,
  rawPath: string,
): Promise<string | null> {
  const target = normalizeRel(rawPath);
  if (!target || !workspacePath) return null;
  let files: string[];
  try {
    files = await listWorkspaceFiles(workspacePath);
  } catch {
    return null;
  }
  if (files.length === 0 || files.includes(target)) return null;

  const targetBase = basenameOf(target).toLowerCase();
  if (!targetBase) return null;
  const targetExt = extOf(targetBase);

  // Only compare against same-extension files (cuts noise + cost); if the target
  // has no extension, fall back to the whole set.
  const pool = targetExt
    ? files.filter((f) => extOf(basenameOf(f).toLowerCase()) === targetExt)
    : files;

  const threshold = Math.max(2, Math.floor(targetBase.length * 0.34));
  const scored: { path: string; d: number }[] = [];
  for (const f of pool) {
    const d = boundedLevenshtein(targetBase, basenameOf(f).toLowerCase(), threshold);
    if (d <= threshold) scored.push({ path: f, d });
  }
  if (scored.length === 0) return null;

  // Closest basename first; break ties by full-path closeness (nearest location).
  scored.sort(
    (a, b) =>
      a.d - b.d ||
      boundedLevenshtein(target, a.path, 999) -
        boundedLevenshtein(target, b.path, 999),
  );
  const top = scored.slice(0, 3).map((s) => `"${s.path}"`);
  return top.length === 1
    ? `Did you mean ${top[0]}?`
    : `Did you mean one of: ${top.join(", ")}?`;
}
