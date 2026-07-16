/**
 * Workspace path confinement for file reads.
 *
 * Rejects paths that escape the workspace root. We do NOT block files by name
 * (`.env`, keys, credential JSON): like opencode / Claude Code, the agent reads
 * files inside the workspace freely — a project's own config is fair game — while
 * anything OUTSIDE the workspace is refused here (and a symlink-resolved escape
 * is refused by realpath-contain.ts). Reading a credential file via a shell
 * command still hits the run_command danger-gate (dangerous-commands.ts), which
 * asks for approval rather than blocking.
 */

import * as path from "node:path";

export const PATH_ESCAPE_BLOCK_MESSAGE = "Path escapes workspace root.";

function decodePercentEncoding(input: string): string {
  try {
    return decodeURIComponent(input);
  } catch {
    return input;
  }
}

/**
 * Normalize user-controlled path fragments before resolve (null bytes, slashes, %XX).
 */
export function sanitizePathInput(p: string): string {
  if (!p || typeof p !== "string") return "";
  // eslint-disable-next-line no-control-regex -- intentionally strip NUL bytes
  let s = p.replace(/\0/g, "");
  s = decodePercentEncoding(s);
  return s.replace(/\\/g, "/");
}

/**
 * Resolve `p` under `workspaceRoot` and reject any path that escapes the root.
 */
export function assertReadablePath(p: string, workspaceRoot: string): void {
  if (!workspaceRoot || typeof workspaceRoot !== "string") {
    throw new Error("Workspace root is required for path validation.");
  }
  const sanitized = sanitizePathInput(p);
  const root = path.resolve(workspaceRoot);
  const resolved = path.isAbsolute(sanitized)
    ? path.resolve(sanitized)
    : path.resolve(root, sanitized);

  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new Error(PATH_ESCAPE_BLOCK_MESSAGE);
  }
}
