/**
 * File-scope permission preflight for chat stream handlers (mirrors run_command gate placement).
 */

import type { FileOperationPreview, PermissionRequest } from "@/lib/tools/permissions/schema";
import { normalizeRelativePath } from "@/lib/file-permission-scope";
import {
  extractRelativePathsFromPreview,
  isFileOperationWithScope,
  runFilePermissionPreflight,
  type FilePermissionPreflight,
} from "./file_permission_handlers";

export type FilePreflightStreamResult = {
  earlyReturn: string | null;
  skipPermissionWait: boolean;
  permRequest: PermissionRequest;
};

/**
 * `chatId`, `sender` and `interceptor` used to be parameters here. They existed
 * only for the `write_multiple_files` partition path (it pre-executed the
 * auto-allowed half through the interceptor and narrated the rest), and that path
 * is gone. An unused `interceptor` argument on a permission function reads as if
 * approval still flows through here, which is worse than a shorter signature.
 */
export async function applyFileScopePreflightInStream(
  permRequest: PermissionRequest,
  effectiveAppId: number | null | undefined,
  emitActivity: (label: string, detail: string) => void,
  emitBlocked: (message: string) => void,
): Promise<FilePreflightStreamResult> {
  if (!isFileOperationWithScope(permRequest.operation)) {
    return { earlyReturn: null, skipPermissionWait: false, permRequest };
  }

  // The `write_multiple_files` branch that stood here — partition into
  // auto-allow / auto-deny / prompt, then re-buffer an ARRAY preview — is gone
  // with the rest of that cluster (v14.36.0). No tool has emitted the operation
  // since write_file folded into edit_file, so the only thing it could produce
  // was a card that showed one file's diff while approving every write in the
  // batch. Single-file requests fall through to the path below, which is what
  // every real request has taken for several releases.

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
