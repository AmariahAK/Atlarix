/**
 * Shared by `glob` and `grep`: where a search is rooted, and what ripgrep's
 * failures mean.
 */
import * as os from "node:os";
import * as path from "node:path";

/** `~` and `~/…` (or `~\…`) to the home folder; anything else unchanged. */
export function expandHome(p: string, home: string = os.homedir()): string {
  const t = p.trim();
  if (t === "~") return home;
  if (/^~[\\/]/.test(t)) return path.join(home, t.slice(2));
  return p;
}

/** Whether `root` lies outside `workspace` (a different tree, not a subfolder). */
export function isOutsideWorkspace(root: string, workspace: string | undefined): boolean {
  if (!workspace) return false;
  const rel = path.relative(path.resolve(workspace), path.resolve(root));
  return rel !== "" && (rel.startsWith("..") || path.isAbsolute(rel));
}

/** Whether `root` is in (or is) a dot-folder of the workspace, e.g. `.atlarix/skills`. */
export function isHiddenRootInWorkspace(root: string, workspace: string | undefined): boolean {
  if (!workspace || isOutsideWorkspace(root, workspace)) return false;
  const rel = path.relative(path.resolve(workspace), path.resolve(root));
  return rel.split(/[\\/]+/).some((s) => s.startsWith(".") && s !== "." && s !== "..");
}

/**
 * A walk error ripgrep reports on stderr while still searching the rest:
 * `rg: ./locked: Permission denied (os error 13)`. It exits 2 for these even
 * when it printed matches, so exit 2 alone does not mean the pattern was bad.
 */
const WALK_ERROR_RE =
  /^rg: (.+?): (?:Permission denied|Operation not permitted|No such file or directory|Access is denied\.?)(?: \(os error \d+\))?$/i;

export type RgFailure =
  /** Only folders it could not read; `stdout` holds whatever it found anyway. */
  | { kind: "walk"; stdout: string; unreadable: string[] }
  /** A real failure (a malformed pattern, say): the first stderr line. */
  | { kind: "fatal"; message: string };

export function classifyRgFailure(err: { stdout?: string; stderr?: string }): RgFailure {
  const lines = (err.stderr ?? "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const unreadable: string[] = [];
  for (const l of lines) {
    const m = WALK_ERROR_RE.exec(l);
    if (!m) return { kind: "fatal", message: lines[0] ?? "" };
    unreadable.push(m[1]!);
  }
  if (unreadable.length === 0) return { kind: "fatal", message: "" };
  return { kind: "walk", stdout: err.stdout ?? "", unreadable };
}

/** "2 folder(s) couldn't be read (permissions): ./locked, ./.Trash" */
export function unreadableNote(unreadable: string[]): string {
  if (unreadable.length === 0) return "";
  const shown = unreadable.slice(0, 3).join(", ");
  const more = unreadable.length > 3 ? `, +${unreadable.length - 3} more` : "";
  return `${unreadable.length} folder(s) couldn't be read (permissions): ${shown}${more}`;
}

/**
 * A path as grep and glob report it: with "/" on every platform. On Windows
 * grep said "src/a.ts" and glob "src\\a.ts" for the same file (QA, ai-b8).
 */
export function toSlashes(p: string): string {
  return p.replace(/\\/g, "/");
}
