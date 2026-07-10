/**
 * Shared ripgrep ignore config for the `grep` and `glob` tools.
 *
 * `--no-require-git` makes ripgrep honor .gitignore/.ignore/.rgignore even
 * OUTSIDE a git repo (rg's default only applies .gitignore inside a git tree) —
 * so file discovery is never flooded with node_modules/dist in a non-git
 * workspace, without any hardcoded exclude list. This is exactly how Claude Code
 * / opencode avoid the flood: ripgrep does the filtering, not a bespoke module.
 *
 * Back-compat: ripgrep reads `.ignore` files natively but not `.atlarixignore`
 * by name, so an existing workspace `.atlarixignore` is fed to rg via
 * `--ignore-file`. No compose/load machinery — just a flag pointing at the file.
 */

import * as path from "node:path";
import { access } from "node:fs/promises";

export async function ripgrepIgnoreArgs(workspace?: string): Promise<string[]> {
  const args = ["--no-require-git"];
  if (workspace) {
    const atlarixIgnore = path.join(workspace, ".atlarixignore");
    try {
      await access(atlarixIgnore);
      args.push("--ignore-file", atlarixIgnore);
    } catch {
      /* no .atlarixignore — rg's native .gitignore/.ignore handling is enough */
    }
  }
  return args;
}
