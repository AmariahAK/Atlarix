/**
 * IPC: workspace file path permissions + stream preflight helpers.
 */

import { ipcMain, type IpcMainInvokeEvent } from "electron";
import log from "electron-log";
import type { FileOperationPreview } from "@/lib/tools/permissions/schema";
import {
  isFileOperationWithScope,
  normalizeRelativePath,
  resolveFilePermissionGate,
  type FilePermissionDecision,
  type FileScopeType,
} from "@/lib/file-permission-scope";
import {
  listWorkspaceFilePermissions as listFilePermsFromDb,
  revokeWorkspaceFilePermission,
  upsertWorkspaceFilePermission,
} from "@/lib/file-permissions-store";

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
      canAlwaysAllowExtension: boolean;
    };

export function extractRelativePathsFromPreview(
  operation: string,
  preview: unknown,
): string[] {
  if (operation === "write_multiple_files" && Array.isArray(preview)) {
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
  const gate = resolveFilePermissionGate(relativePath, operation, perms);

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
    canAlwaysAllowExtension: gate.canAlwaysAllowExtension,
  };
}

export type MultiFilePartition = {
  autoAllow: FileOperationPreview[];
  autoDeny: FileOperationPreview[];
  prompt: FileOperationPreview[];
  autoAllowActivities: Array<{ label: string; path: string }>;
  autoDenyActivities: Array<{ label: string; path: string }>;
};

export function partitionWriteMultipleFilesPreview(
  previews: FileOperationPreview[],
  appId: number | null | undefined,
): MultiFilePartition {
  const autoAllow: FileOperationPreview[] = [];
  const autoDeny: FileOperationPreview[] = [];
  const prompt: FileOperationPreview[] = [];
  const autoAllowActivities: Array<{ label: string; path: string }> = [];
  const autoDenyActivities: Array<{ label: string; path: string }> = [];

  for (const p of previews) {
    if (!p?.path?.trim()) {
      prompt.push(p);
      continue;
    }
    const pre = runFilePermissionPreflight("write_file", normalizeRelativePath(p.path), appId);
    if (pre.type === "auto_allow") {
      autoAllow.push(p);
      autoAllowActivities.push({ label: pre.label, path: p.path });
    } else if (pre.type === "auto_deny") {
      autoDeny.push(p);
      autoDenyActivities.push({ label: pre.label, path: p.path });
    } else {
      prompt.push(p);
    }
  }

  return {
    autoAllow,
    autoDeny,
    prompt,
    autoAllowActivities,
    autoDenyActivities,
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
      upsertWorkspaceFilePermission(appId, scopeType, scopeValue, decision);
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
      const removed = revokeWorkspaceFilePermission(appId, scopeType, scopeValue);
      return { success: removed };
    },
  );
}

export { isFileOperationWithScope };
