/**
 * Which filesystem paths a permission request is about.
 *
 * Extracted from `PermissionInterceptor` (v14.26.0). Pure — it reads a request
 * and returns paths, with no interceptor state involved — but it is load-bearing
 * for security: `ensureOutsideTargetsGranted` gates exactly the paths this
 * returns, so **a path missing from this list is a path that is never gated**.
 * That is why it now has its own tests instead of being covered only indirectly.
 *
 * Behaviour is unchanged from the method it replaces.
 */

import type {
  FileOperationPreview,
  PermissionRequest,
} from "@/lib/tools/permissions/schema";

/**
 * Every path this operation may touch, in the order it declares them.
 *
 * Two cases are easy to get wrong and are the reason this is not a one-liner:
 *
 * - **`rename_file` yields BOTH endpoints.** A rename can carry a file across
 *   the workspace boundary in either direction, and each end is resolved
 *   independently.
 * - **`batch_plan` descends into its children.** It re-dispatches to the file
 *   executors per sub-operation, so its children hit the same containment check.
 *   Collecting them here is what stops a batch asking for nothing and then
 *   throwing part-way through, having already applied the earlier items.
 */
export function targetPathsForOperation(request: PermissionRequest): string[] {
  const out: string[] = [];
  const push = (p: unknown) => {
    if (typeof p === "string" && p.trim()) out.push(p);
  };

  // An array preview is `write_multiple_files` — every entry is a target.
  if (Array.isArray(request.preview)) {
    for (const p of request.preview as FileOperationPreview[]) push(p?.path);
    return out;
  }

  const preview = request.preview as FileOperationPreview | undefined;
  switch (request.operation) {
    case "write_file":
    case "edit_file":
    case "replace_code":
    case "insert_code":
    case "delete_lines":
    case "delete_file":
      push(preview?.path);
      break;
    case "rename_file":
      push(preview?.fromPath);
      push(preview?.toPath);
      break;
    case "batch_plan": {
      const items =
        (request.preview as { operations?: unknown[] } | undefined)
          ?.operations ?? [];
      for (const item of items) {
        const op = item as FileOperationPreview | undefined;
        push(op?.path);
        push(op?.fromPath);
        push(op?.toPath);
      }
      break;
    }
    default:
      break;
  }
  return out;
}
