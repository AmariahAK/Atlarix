/**
 * Workspace file permission scope resolution (path, directory, extension).
 */

import path from "path";

export type FilePermissionDecision = "always_allow" | "always_deny";
export type FileScopeType = "file" | "directory" | "extension";

export type FilePermissionGate =
  | { action: "auto_allow"; matchedScope: string; scopeType: FileScopeType }
  | { action: "auto_deny"; matchedScope: string; scopeType: FileScopeType }
  | {
      action: "prompt";
      relativePath: string;
      isProtected: boolean;
      isDeleteOrRename: boolean;
      parentDir: string;
      extension: string;
      canAlwaysAllowFile: boolean;
      canAlwaysAllowDirectory: boolean;
      canAlwaysAllowExtension: boolean;
    };

/**
 * There is deliberately NO hardcoded protected-path list (removed v14.23.0).
 *
 * It used to name `package.json`, lockfiles, `.env*`, `.pem`/`.key`/`.cert`/`.p12`,
 * `.github/workflows/**` — plus `drizzle.config.ts`, `src/db/schema.ts` and `drizzle/**`,
 * which are ATLARIX'S OWN layout hardcoded into every user's workspace. Any match forced a
 * prompt on EVERY edit and offered no always-allow at all, so a workflow file was a dead end
 * by construction.
 *
 * It also contradicted this codebase's own stated position for file READS
 * (`lib/security/env-secret-paths.ts`): "We do NOT block files by name (`.env`, keys,
 * credential JSON): like opencode / Claude Code, the agent reads files inside the workspace
 * freely — a project's own config is fair game." The write side is now consistent with that.
 *
 * Nothing was traded away. Every write still passes the approval queue with its inline diff;
 * workspace containment and symlink escapes are still refused; a credential read via shell
 * still hits the `run_command` danger gate. Projects that DO want a path to always ask say so
 * in `.atlarix/permissions.json` (see `lib/tools/permissions/ruleset.ts`) — configurable,
 * rather than a constant in the product.
 */

/**
 * Operations the per-file / per-directory / per-extension scope rules apply to.
 *
 * Keyed on PERMISSION OPERATION, not tool name — a request is built fresh each
 * turn and never persisted, so an operation with no producer is unreachable and
 * does not belong here. `write_file`, `replace_code`, `insert_code`,
 * `delete_lines` and `write_multiple_files` were all removed on that basis: every
 * file mutation has gone through `edit_file` since v13.8.
 */
export const FILE_OPS_WITH_SCOPE = new Set([
  "edit_file",
  "delete_file",
  "rename_file",
]);

export function isFileOperationWithScope(operation: string): boolean {
  return FILE_OPS_WITH_SCOPE.has(operation);
}

export function isDeleteOrRenameOperation(operation: string): boolean {
  return operation === "delete_file" || operation === "rename_file";
}

/** Normalize to posix relative path segments (no leading ./). */
export function normalizeRelativePath(raw: string): string {
  const n = path.posix.normalize(raw.replace(/\\/g, "/")).replace(/^\.\//, "");
  if (n === "." || n === "") return "";
  return n;
}

export function getPathExtension(relativePath: string): string {
  const ext = path.posix.extname(relativePath);
  return ext || "";
}

export function getParentDirectory(relativePath: string): string {
  const dir = path.posix.dirname(relativePath);
  if (!dir || dir === ".") return "";
  return dir.endsWith("/") ? dir.slice(0, -1) : dir;
}

/**
 * Only an EMPTY path is refused — that is a malformed request, not a policy.
 * Kept as a function (rather than deleted) because two call sites and the approval UI read
 * it; it now answers "is this path even usable?" instead of "is this file special?".
 */
export function isProtectedRelativePath(relativePath: string): boolean {
  return !normalizeRelativePath(relativePath);
}

export type ListedFilePermission = {
  scopeType: FileScopeType;
  scopeValue: string;
  decision: FilePermissionDecision;
};

function pathUnderDirectory(filePath: string, dirScope: string): boolean {
  const dir = normalizeRelativePath(dirScope);
  if (!dir) return false;
  const file = normalizeRelativePath(filePath);
  if (file === dir) return true;
  return file.startsWith(`${dir}/`);
}

function matchesExtension(filePath: string, extScope: string): boolean {
  const ext = extScope.startsWith(".") ? extScope : `.${extScope}`;
  const fileExt = getPathExtension(filePath);
  return fileExt.toLowerCase() === ext.toLowerCase();
}

/**
 * Resolve gate for a single relative path (already workspace-relative).
 * `listPermissions` should be all rows for the workspace.
 */
export function resolveFilePermissionGate(
  relativePath: string,
  operation: string,
  listPermissions: ListedFilePermission[],
): FilePermissionGate {
  const rel = normalizeRelativePath(relativePath);
  const isProtected = isProtectedRelativePath(rel);
  const isDeleteOrRename = isDeleteOrRenameOperation(operation);
  const parentDir = getParentDirectory(rel);
  const extension = getPathExtension(rel);

  if (isProtected) {
    return {
      action: "prompt",
      relativePath: rel,
      isProtected: true,
      isDeleteOrRename,
      parentDir,
      extension,
      canAlwaysAllowFile: false,
      canAlwaysAllowDirectory: false,
      canAlwaysAllowExtension: false,
    };
  }

  // A path OUTSIDE the workspace always prompts — every scope in this store is
  // workspace-relative and none of them can mean anything about another folder.
  //
  // File and directory scopes simply fail to match a `../…` path, so they were
  // already safe. EXTENSION scopes were not: `matchesExtension` looks only at
  // `path.posix.extname`, so an "always allow .ts" granted for this project
  // silently auto-approved a write to `../any-other-repo/foo.ts` — no card, no
  // diff, because auto_allow skips the approval wait entirely. Granting a folder
  // must not retroactively widen what an old extension rule authorises.
  if (rel.startsWith("../") || rel === "..") {
    return {
      action: "prompt",
      relativePath: rel,
      isProtected: false,
      isDeleteOrRename,
      parentDir,
      extension,
      canAlwaysAllowFile: false,
      canAlwaysAllowDirectory: false,
      canAlwaysAllowExtension: false,
    };
  }

  const findDecision = (
    scopeType: FileScopeType,
    matches: (row: ListedFilePermission) => boolean,
  ): FilePermissionDecision | null => {
    for (const row of listPermissions) {
      if (row.scopeType !== scopeType) continue;
      if (matches(row)) return row.decision;
    }
    return null;
  };

  const fileDecision = findDecision("file", (row) => row.scopeValue === rel);
  if (fileDecision === "always_deny") {
    return { action: "auto_deny", matchedScope: rel, scopeType: "file" };
  }
  if (fileDecision === "always_allow" && !isDeleteOrRename) {
    return { action: "auto_allow", matchedScope: rel, scopeType: "file" };
  }

  const dirRows = listPermissions.filter((r) => r.scopeType === "directory");
  dirRows.sort((a, b) => b.scopeValue.length - a.scopeValue.length);
  for (const row of dirRows) {
    if (!pathUnderDirectory(rel, row.scopeValue)) continue;
    if (row.decision === "always_deny") {
      return { action: "auto_deny", matchedScope: row.scopeValue, scopeType: "directory" };
    }
    if (row.decision === "always_allow" && !isDeleteOrRename) {
      return { action: "auto_allow", matchedScope: row.scopeValue, scopeType: "directory" };
    }
    break;
  }

  const extDecision = findDecision("extension", (row) =>
    matchesExtension(rel, row.scopeValue),
  );
  if (extDecision === "always_deny") {
    return { action: "auto_deny", matchedScope: extension, scopeType: "extension" };
  }
  if (extDecision === "always_allow" && !isDeleteOrRename) {
    return { action: "auto_allow", matchedScope: extension, scopeType: "extension" };
  }

  return {
    action: "prompt",
    relativePath: rel,
    isProtected: false,
    isDeleteOrRename,
    parentDir,
    extension,
    canAlwaysAllowFile: Boolean(rel),
    canAlwaysAllowDirectory: Boolean(parentDir),
    canAlwaysAllowExtension: Boolean(extension),
  };
}

export function normalizeScopeValue(scopeType: FileScopeType, value: string): string {
  const v = value.trim();
  if (scopeType === "extension") {
    return v.startsWith(".") ? v.toLowerCase() : `.${v.toLowerCase()}`;
  }
  if (scopeType === "directory") {
    return normalizeRelativePath(v.replace(/\/+$/, ""));
  }
  return normalizeRelativePath(v);
}
