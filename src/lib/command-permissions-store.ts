/**
 * Workspace-scoped terminal command category permissions (SQLite).
 */

import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { workspaceCommandPermissions } from "@/db/schema";
import type { CommandPermissionDecision } from "@/lib/terminal-command-category";
import { getCommandCategory } from "@/lib/terminal-command-category";
import { resolveCanonicalAppId } from "@/ipc/utils/canonical-app";

export type WorkspaceCommandPermissionRow = {
  id: number;
  appId: number;
  category: string;
  decision: CommandPermissionDecision;
  createdAt: Date | null;
};

export function listWorkspaceCommandPermissions(
  appId: number,
): WorkspaceCommandPermissionRow[] {
  const rows = db
    .select()
    .from(workspaceCommandPermissions)
    .where(eq(workspaceCommandPermissions.appId, appId))
    .all();
  return rows.map((r) => ({
    id: r.id,
    appId: r.appId,
    category: r.category,
    decision: r.decision as CommandPermissionDecision,
    createdAt: r.createdAt,
  }));
}

export function getWorkspaceCommandPermission(
  appId: number,
  category: string,
): CommandPermissionDecision | null {
  const normalized = category.trim().toLowerCase();
  if (!normalized) return null;
  const row = db
    .select()
    .from(workspaceCommandPermissions)
    .where(
      and(
        eq(workspaceCommandPermissions.appId, appId),
        eq(workspaceCommandPermissions.category, normalized),
      ),
    )
    .get();
  return row ? (row.decision as CommandPermissionDecision) : null;
}

export function upsertWorkspaceCommandPermission(
  rawAppId: number,
  category: string,
  decision: CommandPermissionDecision,
): void {
  // Write under the canonical (oldest) row for this folder so the rule lands on
  // the same app the chat enforces under (Bug 5).
  const appId = resolveCanonicalAppId(rawAppId) ?? rawAppId;
  const normalized =
    getCommandCategory(category) || category.trim().toLowerCase();
  if (!normalized) return;

  const existing = db
    .select()
    .from(workspaceCommandPermissions)
    .where(
      and(
        eq(workspaceCommandPermissions.appId, appId),
        eq(workspaceCommandPermissions.category, normalized),
      ),
    )
    .get();

  if (existing) {
    db.update(workspaceCommandPermissions)
      .set({ decision })
      .where(eq(workspaceCommandPermissions.id, existing.id))
      .run();
    return;
  }

  db.insert(workspaceCommandPermissions)
    .values({
      appId,
      category: normalized,
      decision,
    })
    .run();
}

export function revokeWorkspaceCommandPermission(
  rawAppId: number,
  category: string,
): boolean {
  const appId = resolveCanonicalAppId(rawAppId) ?? rawAppId;
  const normalized = category.trim().toLowerCase();
  if (!normalized) return false;
  const result = db
    .delete(workspaceCommandPermissions)
    .where(
      and(
        eq(workspaceCommandPermissions.appId, appId),
        eq(workspaceCommandPermissions.category, normalized),
      ),
    )
    .run();
  return result.changes > 0;
}
