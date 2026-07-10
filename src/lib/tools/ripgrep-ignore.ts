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

export async function ripgrepIgnoreArgs(workspace?: string): Promise<string[]> {
  const args = ["--no-ignore-parent", "--no-ignore-global"];
  if (workspace) {
    for (const name of [".gitignore", ".atlarixignore"]) {
      const file = path.join(workspace, name);
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
