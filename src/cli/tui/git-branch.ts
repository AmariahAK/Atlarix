import fs from "node:fs";
import path from "node:path";

/**
 * The checked-out branch of the repository holding `dir`, read from `.git/HEAD`
 * (no git process). A worktree's `.git` is a file pointing at its own HEAD.
 * A detached HEAD shows its short hash; no repository, null.
 */
export function gitBranch(dir: string): string | null {
  for (let d = path.resolve(dir); ; d = path.dirname(d)) {
    const dotGit = path.join(d, ".git");
    try {
      const stat = fs.statSync(dotGit);
      const gitDir = stat.isDirectory()
        ? dotGit
        : path.resolve(d, /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(dotGit, "utf8"))?.[1]?.trim() ?? "");
      const head = fs.readFileSync(path.join(gitDir, "HEAD"), "utf8").trim();
      const ref = /^ref:\s*refs\/heads\/(.+)$/.exec(head);
      return ref ? ref[1]! : head.slice(0, 7) || null;
    } catch {
      // Not here: try the parent.
    }
    if (path.dirname(d) === d) return null;
  }
}
