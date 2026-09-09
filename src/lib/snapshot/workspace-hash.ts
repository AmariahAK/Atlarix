/**
 * Walk workspace and compute MD5 per file (relative posix path → hex hash).
 * Mirrors legacy diagram internal-git ignore rules.
 */

import * as path from "path";

export function atlasDir(workspacePath: string): string {
  return path.join(workspacePath, ".atlarix");
}
