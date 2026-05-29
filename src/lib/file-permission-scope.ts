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

const PROTECTED_EXACT = new Set([
  "package.json",
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "drizzle.config.ts",
  "src/db/schema.ts",
]);

const PROTECTED_SUFFIXES = [".pem", ".key", ".cert", ".p12"];

export const FILE_OPS_WITH_SCOPE = new Set([
  "write_file",
  "edit_file",
  "replace_code",
  "insert_code",
  "delete_lines",
  "write_multiple_files",
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

export function isProtectedRelativePath(relativePath: string): boolean {
  const rel = normalizeRelativePath(relativePath);
  if (!rel) return true;
  if (PROTECTED_EXACT.has(rel)) return true;
  const base = path.posix.basename(rel);
  if (base === ".env" || base.startsWith(".env.")) return true;
  const lower = rel.toLowerCase();
  if (PROTECTED_SUFFIXES.some((s) => lower.endsWith(s))) return true;
  if (rel === "drizzle" || rel.startsWith("drizzle/")) return true;
  if (rel === ".github/workflows" || rel.startsWith(".github/workflows/")) return true;
  return false;
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
