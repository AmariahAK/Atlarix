/**
 * Detect workspace paths whose basenames look like environment secret files
 * (.env, .env.*, *.env) so agents cannot read them via tools or context assembly.
 */

import * as path from "node:path";

/** Basename: `.env`, `.env.local`, `.env.production`, `*.env`, etc. */
export const ENV_SECRET_BASENAME_RE =
  /^(?:\.env(?:\.[^/\\]+)*|[^/\\]+\.env)$/i;

export const ENV_SECRET_BLOCK_MESSAGE =
  "This file contains sensitive environment variables and cannot be read by the agent.";

/**
 * True if the path's final segment matches env-secret filename patterns.
 * Works for absolute paths, relative paths, and forward/back slashes.
 */
export function isEnvSecretPath(p: string): boolean {
  if (!p || typeof p !== "string") return false;
  const normalized = p.replace(/\\/g, "/");
  const basename = path.basename(normalized);
  return ENV_SECRET_BASENAME_RE.test(basename);
}
