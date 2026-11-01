/**
 * IPC: workspace file path permissions + stream preflight helpers.
 */

import { ipcMain, type IpcMainInvokeEvent } from "electron";
import log from "electron-log";
import type { FileOperationPreview } from "@/lib/tools/permissions/schema";
import {
  isFileOperationWithScope,
  resolveFilePermissionGate,
  type FilePermissionDecision,
  type FileScopeType,
} from "@/lib/file-permission-scope";
import {
  listSandboxWritablePaths,
  listWorkspaceFilePermissions as listFilePermsFromDb,
  revokeSandboxWritablePath,
  revokeWorkspaceFilePermission,
  toRepoRelativePathForApp,
  upsertSandboxWritablePath,
  upsertWorkspaceFilePermission,
} from "@/lib/file-permissions-store";
import * as fsSync from "node:fs";
import * as nodePath from "node:path";

const logger = log.scope("file-permissions");

export type FilePermissionPreflight =
  | { type: "auto_allow"; label: string; relativePath: string }
  | { type: "auto_deny"; label: string; relativePath: string }
  | {
      type: "prompt";
      relativePath: string;
      isProtected: boolean;
      isDeleteOrRename: boolean;
      parentDir: string;
      extension: string;
      canAlwaysAllowFile: boolean;
      canAlwaysAllowDirectory: boolean;
      canAlwaysAllowFolder: boolean;
      canAlwaysAllowExtension: boolean;
    };

export function extractRelativePathsFromPreview(
  operation: string,
  preview: unknown,
): string[] {
  // Keyed on the SHAPE, not on an operation name. It used to read
  // `operation === "write_multiple_files"`, which is gone — but the branch stays
  // generic rather than being deleted, because these paths feed permission
  // checks: an array preview that fell through would extract NO paths and the
  // caller would check nothing. Fail closed on a shape we do not recognize.
  if (Array.isArray(preview)) {
    return (preview as FileOperationPreview[])
      .map((p) => p?.path)
      .filter((p): p is string => Boolean(p?.trim()));
  }
  const p = preview as FileOperationPreview;
  if (operation === "rename_file") {
    const paths: string[] = [];
    if (p?.toPath?.trim()) paths.push(p.toPath);
    else if (p?.path?.trim()) paths.push(p.path);
    if (p?.fromPath?.trim()) paths.push(p.fromPath);
    return paths;
  }
  if (p?.path?.trim()) return [p.path];
  return [];
}

export function runFilePermissionPreflight(
  operation: string,
  relativePath: string,
  appId: number | null | undefined,
): FilePermissionPreflight {
  const perms = appId != null ? listFilePermsFromDb(appId) : [];
  // Stored path scopes are repo-relative (0g); the incoming path is
  // workspace-relative, so re-express it before comparing.
  const gatePath =
    appId != null ? toRepoRelativePathForApp(appId, relativePath) : relativePath;
  const gate = resolveFilePermissionGate(gatePath, operation, perms);

  if (gate.action === "auto_allow") {
    const scopeLabel =
      gate.scopeType === "extension"
        ? gate.matchedScope
        : gate.scopeType === "directory"
          ? `${gate.matchedScope}/`
          : gate.matchedScope;
    return {
      type: "auto_allow",
      label: `${operation} auto-approved (${scopeLabel})`,
      relativePath,
    };
  }
  if (gate.action === "auto_deny") {
    return {
      type: "auto_deny",
      label: `${operation} blocked (${gate.matchedScope})`,
      relativePath,
    };
  }
  return {
    type: "prompt",
    relativePath: gate.relativePath,
    isProtected: gate.isProtected,
    isDeleteOrRename: gate.isDeleteOrRename,
    parentDir: gate.parentDir,
    extension: gate.extension,
    canAlwaysAllowFile: gate.canAlwaysAllowFile,
    canAlwaysAllowDirectory: gate.canAlwaysAllowDirectory,
    canAlwaysAllowFolder: gate.canAlwaysAllowFolder,
    canAlwaysAllowExtension: gate.canAlwaysAllowExtension,
  };
}

export function registerFilePermissionHandlers(): void {
  ipcMain.handle(
    "file-permissions:list",
    (_event: IpcMainInvokeEvent, { appId }: { appId: number }) => {
      if (!appId) return [];
      return listFilePermsFromDb(appId);
    },
  );

  ipcMain.handle(
    "file-permissions:upsert",
    (
      _event: IpcMainInvokeEvent,
      {
        appId,
        scopeType,
        scopeValue,
        decision,
      }: {
        appId: number;
        scopeType: FileScopeType;
        scopeValue: string;
        decision: FilePermissionDecision;
      },
    ) => {
      if (!appId || !scopeValue?.trim()) {
        return { success: false, error: "Invalid appId or scope" };
      }
      try {
        upsertWorkspaceFilePermission(appId, scopeType, scopeValue, decision);
      } catch (e) {
        // Degrade instead of throwing raw SqliteError out of IPC (e.g. disk full
        // → the rollback journal can't be created).
        logger.warn(
          `upsert failed app=${appId} type=${scopeType} value=${scopeValue}:`,
          e,
        );
        return {
          success: false,
          error: "Couldn't save permission (storage may be full).",
        };
      }
      logger.log(
        `upsert app=${appId} type=${scopeType} value=${scopeValue} decision=${decision}`,
      );
      return { success: true };
    },
  );

  ipcMain.handle(
    "file-permissions:revoke",
    (
      _event: IpcMainInvokeEvent,
      {
        appId,
        scopeType,
        scopeValue,
      }: { appId: number; scopeType: FileScopeType; scopeValue: string },
    ) => {
      if (!appId || !scopeValue?.trim()) {
        return { success: false };
      }
      const removed = revokeWorkspaceFilePermission(
        appId,
        scopeType,
        scopeValue,
      );
      return { success: removed };
    },
  );

  // ── Granted folders (writable directories outside the workspace) ───────────
  //
  // Stored on the same table under the `sandbox_path` scope, which
  // `listWorkspaceFilePermissions` deliberately excludes — these are absolute OS
  // paths, not workspace-relative scopes, so they get their own channels rather
  // than being mixed into the file/directory/extension table.
  //
  // ONE list serves both lanes: the command sandbox reads it for
  // `extraWritablePaths`, and the permission interceptor reads it to allow
  // `edit_file` outside the workspace. Granting once covers both.

  ipcMain.handle(
    "file-permissions:list-granted-folders",
    (_event: IpcMainInvokeEvent, { appId }: { appId: number }) => {
      if (!appId) return [];
      try {
        return listSandboxWritablePaths(appId).map((p) => ({
          path: p,
          // Surfaced so the UI can flag a grant whose folder has since been
          // moved or deleted, instead of showing a dead row with no explanation.
          exists: fsSync.existsSync(p),
        }));
      } catch (e) {
        logger.warn(`list granted folders failed app=${appId}:`, e);
        return [];
      }
    },
  );

  ipcMain.handle(
    "file-permissions:grant-folder",
    (
      _event: IpcMainInvokeEvent,
      { appId, path: rawPath }: { appId: number; path: string },
    ) => {
      const target = rawPath?.trim();
      if (!appId || !target)
        return { success: false, error: "Invalid workspace or folder." };
      if (!nodePath.isAbsolute(target)) {
        return {
          success: false,
          error: "Choose a folder using its full path.",
        };
      }
      let resolved: string;
      try {
        // realpath so the stored grant matches what the containment checks
        // compare against (macOS /var → /private/var would otherwise never hit).
        resolved = fsSync.realpathSync(target);
        if (!fsSync.statSync(resolved).isDirectory()) {
          return { success: false, error: "That path is not a folder." };
        }
      } catch {
        return { success: false, error: "That folder doesn't exist." };
      }
      try {
        upsertSandboxWritablePath(appId, resolved);
      } catch (e) {
        logger.warn(`grant folder failed app=${appId} path=${resolved}:`, e);
        return {
          success: false,
          error: "Couldn't save the grant (storage may be full).",
        };
      }
      logger.log(`granted folder app=${appId} path=${resolved}`);
      return { success: true, path: resolved };
    },
  );

  ipcMain.handle(
    "file-permissions:revoke-granted-folder",
    (
      _event: IpcMainInvokeEvent,
      { appId, path: target }: { appId: number; path: string },
    ) => {
      if (!appId || !target?.trim()) return { success: false };
      // Takes effect immediately: the interceptor re-reads this list per
      // outside-path write rather than caching it per session.
      const removed = revokeSandboxWritablePath(appId, target.trim());
      logger.log(
        `revoked folder app=${appId} path=${target} removed=${removed}`,
      );
      return { success: removed };
    },
  );
}

export { isFileOperationWithScope };
