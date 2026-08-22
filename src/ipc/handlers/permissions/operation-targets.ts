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

  // Any array preview: every entry is a target. This was written for
  // `write_multiple_files`, which no longer exists, and it stays because it fails
  // CLOSED — an unrecognized array shape that fell through to the switch below
  // would yield NO targets, and no targets means the containment check passes by
  // having nothing to check.
  if (Array.isArray(request.preview)) {
    for (const p of request.preview as FileOperationPreview[]) push(p?.path);
    return out;
  }

  const preview = request.preview as FileOperationPreview | undefined;
  switch (request.operation) {
    case "edit_file":
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
      /**
       * Fail CLOSED on an operation this switch does not know.
       *
       * This used to `break` with nothing pushed, which sounds harmless and is the
       * opposite: per this file's own header, a path missing from the list is a
       * path that is never gated — so an unrecognized operation got its targets
       * checked against nothing and sailed through containment. The only reason it
       * never bit is that every operation happened to be listed.
       *
       * Pushing the generic preview fields instead means a new operation is gated
       * by default and someone has to opt it OUT, which is the right direction for
       * a security funnel. It also lets the dead `write_file` / `replace_code` /
       * `insert_code` / `delete_lines` labels go (no producer has emitted them
       * since `write_file` folded into `edit_file`) without that removal quietly
       * becoming a fail-open change.
       */
      push(preview?.path);
      push(preview?.fromPath);
      push(preview?.toPath);
      break;
  }
  return out;
}
