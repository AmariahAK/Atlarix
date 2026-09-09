/**
 * Sanitize tool-supplied paths so models cannot recreate host absolute paths
 * under the workspace (e.g. workspace/Users/you/.../project/src).
 */
import * as path from "path";
import { realpathSync } from "node:fs";

/** First path segments that usually mean the model pasted an absolute path as "relative". */
const BLOCKED_FIRST_SEGMENTS = new Set(
  [
    "Users",
    "home",
    "Volumes",
    "private",
    "mnt",
    "var",
    "usr",
    "etc",
    "opt",
    "proc",
    "sys",
    "run",
    "tmp",
    "Program Files",
    "Program Files (x86)",
    "ProgramData",
  ].map((s) => s.toLowerCase()),
);

/** Exported for tools that have no workspace root (resolve against cwd with same prefix stripping). */
export function stripToolPathPrefixes(raw: string): string {
  return raw
    .trim()
    .replace(/^\/workspace\//i, "")
    .replace(/^workspace\//i, "")
    .replace(/^\/+/, "");
}

function segmentsOf(p: string): string[] {
  return p.split(/[/\\]+/).filter((s) => s.length > 0);
}

/**
 * Returns a normalized relative path (platform separators) safe to join under workspaceRoot.
 * @throws Error with a clear message if the path escapes or looks like a pasted absolute path.
 */
export function safeRelativePathUnderWorkspace(raw: string): string {
  let s = stripToolPathPrefixes(raw);
  if (s === "") {
    s = ".";
  }
  if (s.startsWith("\\\\") || s.startsWith("\\\\?\\")) {
    throw new Error(
      "Invalid path: UNC paths are not allowed. Use a path relative to the project root (e.g. src/App.tsx).",
    );
  }
  if (/^[A-Za-z]:[\\/]/.test(s)) {
    throw new Error(
      "Invalid path: drive-letter paths are not allowed as relative paths. Use a path relative to the project root.",
    );
  }

  const normalized = path.normalize(s);
  const segs = segmentsOf(normalized);
  if (segs.some((seg) => seg === "..")) {
    throw new Error(
      'Invalid path: ".." is not allowed. Use a path relative to the project root.',
    );
  }

  const first = segs[0];
  if (first !== undefined && BLOCKED_FIRST_SEGMENTS.has(first.toLowerCase())) {
    throw new Error(
      `Invalid path: "${first}/..." looks like an absolute system path pasted as relative. Use paths from the project root only (e.g. src/... not Users/...).`,
    );
  }

  return normalized;
}

/**
 * Resolve a tool-supplied path to an absolute path guaranteed under workspaceRoot.
 */
export function resolvePathUnderWorkspace(
  workspaceRoot: string,
  raw: string,
): string {
  const root = path.resolve(workspaceRoot);
  const rel = safeRelativePathUnderWorkspace(raw);
  const full = path.resolve(root, rel);
  const relCheck = path.relative(root, full);
  if (relCheck.startsWith("..") || path.isAbsolute(relCheck)) {
    throw new Error(
      "Path resolves outside the workspace. Use a path relative to the project root.",
    );
  }
  return full;
}

/** Realpath a path (or its deepest existing ancestor) to defuse symlink escapes. */
function realpathDeepest(abs: string): string {
  let p = abs;
  // Walk up to the first ancestor that exists, realpath it, then re-append.
  const tail: string[] = [];
  // Bounded walk (path depth is finite); stops at the filesystem root.
  for (let i = 0; i < 4096; i++) {
    try {
      const real = realpathSync(p);
      return tail.length ? path.join(real, ...tail.reverse()) : real;
    } catch {
      const parent = path.dirname(p);
      if (parent === p) return abs; // reached root without an existing ancestor
      tail.push(path.basename(p));
      p = parent;
    }
  }
  return abs;
}

/**
 * Resolve a tool path, allowing an EXPLICIT absolute path to target a location
 * outside the workspace (the caller decides the policy: reads auto-allow, writes
 * go through the approval gate). A RELATIVE path stays confined under the
 * workspace exactly as before (`..` and absolute-looking relative pastes like
 * `Users/…` are still rejected). Symlinks are realpath'd so an in-workspace
 * symlink can't smuggle an outside target past `isOutsideWorkspace`.
 */
export function resolveToolTargetPath(
  workspaceRoot: string,
  raw: string,
): { absPath: string; isOutsideWorkspace: boolean } {
  const root = realpathDeepest(path.resolve(workspaceRoot));
  const trimmed = (raw ?? "").trim();

  if (path.isAbsolute(trimmed)) {
    const absPath = realpathDeepest(path.resolve(trimmed));
    const relCheck = path.relative(root, absPath);
    const isOutsideWorkspace =
      relCheck !== "" &&
      (relCheck.startsWith("..") || path.isAbsolute(relCheck));
    return { absPath, isOutsideWorkspace };
  }

  // An explicitly relative `../` path resolves like the shell would.
  //
  // Rejecting `../telios` while ALLOWING the byte-identical absolute path was
  // arbitrary — and expensive: an agent asked to look at a sibling project got a
  // tool error, then had to spend `pwd`, `ls ..`, and a `find` just to rediscover
  // a path it was permitted to read the whole time. The rule was never "you may
  // not leave the workspace" (reads have always been allowed anywhere, and writes
  // are gated by the folder-grant flow at the interceptor); it was only "you may
  // not leave it by writing `..`", which is a spelling rule, not a boundary.
  //
  // `isOutsideWorkspace` is returned honestly so callers keep gating on WHERE the
  // path lands rather than on how it was typed. Everything else about relative
  // resolution is unchanged — in particular `safeRelativePathUnderWorkspace`
  // still rejects a pasted absolute path that lost its leading slash
  // (`Users/me/x`), which is a mistake to catch, not a location to allow.
  if (/^\.\.[\\/]/.test(trimmed) || trimmed === "..") {
    const absPath = realpathDeepest(path.resolve(root, trimmed));
    const relCheck = path.relative(root, absPath);
    const isOutsideWorkspace =
      relCheck !== "" &&
      (relCheck.startsWith("..") || path.isAbsolute(relCheck));
    return { absPath, isOutsideWorkspace };
  }

  // Everything else → confined under the workspace (unchanged security posture).
  return {
    absPath: resolvePathUnderWorkspace(root, trimmed),
    isOutsideWorkspace: false,
  };
}
