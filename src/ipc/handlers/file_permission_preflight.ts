/**
 * File-scope permission preflight for chat stream handlers (mirrors run_command gate placement).
 */

import type { WebContents } from "electron";
import type { FileOperationPreview, PermissionRequest } from "@/lib/tools/permissions/schema";
import { normalizeRelativePath } from "@/lib/file-permission-scope";
import type { PermissionInterceptor } from "./permissions/interceptor";
import {
  extractRelativePathsFromPreview,
  isFileOperationWithScope,
  partitionWriteMultipleFilesPreview,
  runFilePermissionPreflight,
  type FilePermissionPreflight,
} from "./file_permission_handlers";

export type FilePreflightStreamResult = {
  earlyReturn: string | null;
  skipPermissionWait: boolean;
  permRequest: PermissionRequest;
};

export async function applyFileScopePreflightInStream(
  permRequest: PermissionRequest,
  effectiveAppId: number | null | undefined,
  chatId: number,
  sender: WebContents,
  interceptor: PermissionInterceptor,
  emitActivity: (label: string, detail: string) => void,
  emitBlocked: (message: string) => void,
): Promise<FilePreflightStreamResult> {
  if (!isFileOperationWithScope(permRequest.operation)) {
    return { earlyReturn: null, skipPermissionWait: false, permRequest };
  }

  if (permRequest.operation === "write_multiple_files" && Array.isArray(permRequest.preview)) {
    const previews = permRequest.preview as FileOperationPreview[];
    const part = partitionWriteMultipleFilesPreview(previews, effectiveAppId);
    for (const a of part.autoAllowActivities) {
      emitActivity(a.label, a.path);
    }
    for (const a of part.autoDenyActivities) {
      emitActivity(a.label, a.path);
      emitBlocked(`Edit blocked (${a.path}) — change in Settings`);
    }
    if (part.autoAllow.length) {
      await interceptor.preExecuteWritePreviews(part.autoAllow);
    }
    if (!part.prompt.length) {
      if (part.autoDeny.length && !part.autoAllow.length) {
        return {
          earlyReturn: JSON.stringify({
            success: false,
            error: "All file writes were blocked by workspace file permissions.",
            operation: "write_multiple_files",
          }),
          skipPermissionWait: false,
          permRequest,
        };
      }
      return {
        earlyReturn: JSON.stringify({
          success: true,
          message: `Wrote ${part.autoAllow.length} file(s)`,
          operation: "write_multiple_files",
        }),
        skipPermissionWait: false,
        permRequest,
      };
    }
    const enrichedPrompt = part.prompt.map((p) => {
      if (!p?.path?.trim()) return p;
      const pre = runFilePermissionPreflight(
        "write_file",
        normalizeRelativePath(p.path),
        effectiveAppId,
      );
      if (pre.type !== "prompt") return p;
      return {
        ...p,
        isProtectedFile: pre.isProtected,
        isDeleteOrRename: pre.isDeleteOrRename,
        canAlwaysAllowFile: pre.canAlwaysAllowFile,
        canAlwaysAllowDirectory: pre.canAlwaysAllowDirectory,
        canAlwaysAllowExtension: pre.canAlwaysAllowExtension,
        fileParentDir: pre.parentDir,
        fileExtension: pre.extension,
      };
    });
    const nextRequest: PermissionRequest = {
      ...permRequest,
      preview: enrichedPrompt,
    };
    return {
      earlyReturn: null,
      skipPermissionWait: false,
      permRequest: enrichFilePermissionRequest(nextRequest, effectiveAppId),
    };
  }

  const preview = permRequest.preview as FileOperationPreview;
  const paths = extractRelativePathsFromPreview(permRequest.operation, permRequest.preview);
  const primary =
    permRequest.operation === "rename_file"
      ? normalizeRelativePath(preview?.toPath || preview?.path || paths[0] || "")
      : normalizeRelativePath(paths[0] ?? preview?.path ?? "");

  if (!primary) {
    return {
      earlyReturn: null,
      skipPermissionWait: false,
      permRequest: enrichFilePermissionRequest(permRequest, effectiveAppId),
    };
  }

  const pre = runFilePermissionPreflight(permRequest.operation, primary, effectiveAppId);
  if (pre.type === "auto_deny") {
    emitActivity(pre.label, primary);
    emitBlocked(`Edit blocked (${primary}) — change in Settings`);
    return {
      earlyReturn: JSON.stringify({
        success: false,
        error: `Edit blocked by workspace policy (${primary}). Update File permissions in Settings.`,
        operation: permRequest.operation,
      }),
      skipPermissionWait: false,
      permRequest,
    };
  }
  if (pre.type === "auto_allow") {
    emitActivity(pre.label, primary);
    return { earlyReturn: null, skipPermissionWait: true, permRequest };
  }

  return {
    earlyReturn: null,
    skipPermissionWait: false,
    permRequest: enrichFilePermissionRequest(permRequest, effectiveAppId, pre),
  };
}

export function enrichFilePermissionRequest(
  permRequest: PermissionRequest,
  appId: number | null | undefined,
  pre?: FilePermissionPreflight,
): PermissionRequest {
  if (!isFileOperationWithScope(permRequest.operation)) return permRequest;
  if (permRequest.operation === "write_multiple_files") return permRequest;

  const preview = permRequest.preview as FileOperationPreview;
  const resolved =
    pre?.type === "prompt"
      ? pre
      : runFilePermissionPreflight(
          permRequest.operation,
          normalizeRelativePath(preview?.path ?? preview?.toPath ?? ""),
          appId,
        );

  if (resolved.type !== "prompt") return permRequest;

  return {
    ...permRequest,
    preview: {
      ...preview,
      isProtectedFile: resolved.isProtected,
      isDeleteOrRename: resolved.isDeleteOrRename,
      canAlwaysAllowFile: resolved.canAlwaysAllowFile,
      canAlwaysAllowDirectory: resolved.canAlwaysAllowDirectory,
      canAlwaysAllowExtension: resolved.canAlwaysAllowExtension,
      fileParentDir: resolved.parentDir,
      fileExtension: resolved.extension,
    },
  };
}
