/**
 * Workspace-scoped file path permissions (SQLite).
 */

import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { workspaceFilePermissions } from "@/db/schema";
import type { FilePermissionDecision, FileScopeType } from "@/lib/file-permission-scope";
import { normalizeScopeValue } from "@/lib/file-permission-scope";

export type WorkspaceFilePermissionRow = {
  id: number;
  appId: number;
  scopeType: FileScopeType;
  scopeValue: string;
  decision: FilePermissionDecision;
  createdAt: Date | null;
};

export function listWorkspaceFilePermissions(appId: number): WorkspaceFilePermissionRow[] {
  const rows = db
    .select()
    .from(workspaceFilePermissions)
    .where(eq(workspaceFilePermissions.appId, appId))
    .all();
  return rows.map((r) => ({
    id: r.id,
    appId: r.appId,
    scopeType: r.scopeType as FileScopeType,
    scopeValue: r.scopeValue,
    decision: r.decision as FilePermissionDecision,
    createdAt: r.createdAt,
  }));
}

export function upsertWorkspaceFilePermission(
  appId: number,
  scopeType: FileScopeType,
  scopeValue: string,
  decision: FilePermissionDecision,
): void {
  const normalized = normalizeScopeValue(scopeType, scopeValue);
  if (!normalized) return;

  const existing = db
    .select()
    .from(workspaceFilePermissions)
    .where(
      and(
        eq(workspaceFilePermissions.appId, appId),
        eq(workspaceFilePermissions.scopeType, scopeType),
        eq(workspaceFilePermissions.scopeValue, normalized),
      ),
    )
    .get();

  if (existing) {
    db.update(workspaceFilePermissions)
      .set({ decision })
      .where(eq(workspaceFilePermissions.id, existing.id))
      .run();
    return;
  }

  db.insert(workspaceFilePermissions)
    .values({
      appId,
      scopeType,
      scopeValue: normalized,
      decision,
    })
    .run();
}

export function revokeWorkspaceFilePermission(
  appId: number,
  scopeType: FileScopeType,
  scopeValue: string,
): boolean {
  const normalized = normalizeScopeValue(scopeType, scopeValue);
  if (!normalized) return false;
  const result = db
    .delete(workspaceFilePermissions)
    .where(
      and(
        eq(workspaceFilePermissions.appId, appId),
        eq(workspaceFilePermissions.scopeType, scopeType),
        eq(workspaceFilePermissions.scopeValue, normalized),
      ),
    )
    .run();
  return result.changes > 0;
}
