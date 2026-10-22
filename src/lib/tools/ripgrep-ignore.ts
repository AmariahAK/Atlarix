/**
 * Shared ripgrep ignore config for the `grep` and `glob` tools.
 *
 * We confine ripgrep's ignore-reading to the WORKSPACE ITSELF:
 * - `--no-ignore-parent` + `--no-ignore-global` stop rg from applying
 *   `.gitignore`/`.ignore` files in PARENT directories or global git config
 *   (`core.excludesFile`). Without this, opening a folder nested under another
 *   repo — or a temp dir on a CI runner — would silently inherit unrelated
 *   ignore rules and hide the workspace's own files.
 * - The workspace's OWN `.gitignore` and `.atlarixignore` are applied explicitly
 *   via `--ignore-file`, so they're honored even when the workspace is NOT a git
 *   repo (rg's default only reads `.gitignore` inside a git tree). In a real git
 *   repo the in-tree `.gitignore` still prunes node_modules/dist as usual.
 *
 * Net effect: file discovery honors the user's own ignores (like Claude Code /
 * opencode) with zero dependence on the workspace's surrounding directory tree.
 */

import * as path from "node:path";
import { access } from "node:fs/promises";
import { isHiddenRootInWorkspace, isOutsideWorkspace } from "./search-root";

/**
 * `root`, when given, is where this search starts. A root OUTSIDE the workspace
 * (a memory folder under `~/.atlarix…`, a sibling project) is an explicit
 * target: the workspace's ignore files are not applied there — ripgrep matches
 * an `--ignore-file` relative to its cwd, so the workspace's `*.md` hid the notes
 * in an unrelated folder (QA 4(c), 2026-10-22) — but the folder's OWN are, so a
 * sibling project that is not a git repo still keeps its node_modules out (QA
 * A6). Hidden files are included, since the folder itself was named. A root inside a dot-folder of the
 * workspace (`.atlarix/skills`) includes hidden files too. `.git` stays out.
 * In-workspace searches are unchanged: node_modules and dist stay hidden.
 */
export async function ripgrepIgnoreArgs(workspace?: string, root?: string): Promise<string[]> {
  const args = ["--no-ignore-parent", "--no-ignore-global"];
  const outside = !!root && isOutsideWorkspace(root, workspace);
  if (outside || (!!root && isHiddenRootInWorkspace(root, workspace))) {
    args.push("--hidden", "-g", "!.git/");
  }
  const ignoreRoot = outside ? root : workspace;
  if (ignoreRoot) {
    for (const name of [".gitignore", ".atlarixignore"]) {
      const file = path.join(ignoreRoot, name);
      try {
        await access(file);
        args.push("--ignore-file", file);
      } catch {
        /* absent — nothing to add for this file */
      }
    }
  }
  return args;
}
