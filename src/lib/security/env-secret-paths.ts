/**
 * Block workspace paths that look like secrets (.env, keys, credential JSON)
 * and reject paths that escape the workspace root.
 */

import * as path from "node:path";

/** Basename: `.env`, `.env.local`, `.env.production`, `*.env`, etc. */
export const ENV_SECRET_BASENAME_RE =
  /^(?:\.env(?:\.[^/\\]+)*|[^/\\]+\.env)$/i;

const SECRET_EXTENSION_RE = /\.(pem|key|p12|pfx)$/i;

const SECRET_EXACT_BASENAMES = new Set([
  "secrets.json",
  "credentials.json",
  "service-account.json",
]);

export const ENV_SECRET_BLOCK_MESSAGE =
  "This file contains sensitive environment variables and cannot be read by the agent.";

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
 * True when the final path segment matches secret filename patterns.
 */
export function isBlockedSecretBasename(name: string): boolean {
  if (!name || typeof name !== "string") return false;
  const basename = path.basename(name.replace(/\\/g, "/"));
  const lower = basename.toLowerCase();
  if (SECRET_EXACT_BASENAMES.has(lower)) return true;
  if (ENV_SECRET_BASENAME_RE.test(basename)) return true;
  if (SECRET_EXTENSION_RE.test(basename)) return true;
  return false;
}

/**
 * Resolve `p` under `workspaceRoot`, reject escape, then block secret basenames.
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
  if (isBlockedSecretBasename(path.basename(resolved))) {
    throw new Error(ENV_SECRET_BLOCK_MESSAGE);
  }
}

/**
 * IPC `file:read-content`: basename-only secret check (no workspace threading in renderer).
 */
export function assertIpcReadableFilePath(filePath: string): void {
  const sanitized = sanitizePathInput(filePath);
  const basename = path.basename(sanitized.replace(/\\/g, "/"));
  if (isBlockedSecretBasename(basename)) {
    throw new Error(ENV_SECRET_BLOCK_MESSAGE);
  }
}
