/**
 * Workspace-scoped file path permissions (SQLite).
 */

import { and, eq, ne } from "drizzle-orm";
import { db } from "@/db";
import { workspaceFilePermissions } from "@/db/schema";
import type {
  FilePermissionDecision,
  FileScopeType,
} from "@/lib/file-permission-scope";
import { normalizeScopeValue } from "@/lib/file-permission-scope";
import { resolveCanonicalAppId } from "@/ipc/utils/canonical-app";

/**
 * Reused scope value for sandbox writable-path grants (escalation-on-denial).
 * Rows with this scopeType store an ABSOLUTE OS path verbatim (no relative
 * normalization) and are consumed only by the command sandbox — the file-write
 * gate filters them out (see `listWorkspaceFilePermissions`).
 */
const SANDBOX_PATH_SCOPE = "sandbox_path" as const;

export type WorkspaceFilePermissionRow = {
  id: number;
  appId: number;
  scopeType: FileScopeType;
  scopeValue: string;
  decision: FilePermissionDecision;
  createdAt: Date | null;
};

export function listWorkspaceFilePermissions(
  appId: number,
): WorkspaceFilePermissionRow[] {
  const rows = db
    .select()
    .from(workspaceFilePermissions)
    .where(
      and(
        eq(workspaceFilePermissions.appId, appId),
        // Exclude sandbox_path rows — the file-write gate must never see them.
        ne(workspaceFilePermissions.scopeType, SANDBOX_PATH_SCOPE),
      ),
    )
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
  rawAppId: number,
  scopeType: FileScopeType,
  scopeValue: string,
  decision: FilePermissionDecision,
): void {
  // Write under the canonical (oldest) row for this folder so the rule lands on
  // the same app the chat enforces under (Bug 5).
  const appId = resolveCanonicalAppId(rawAppId) ?? rawAppId;
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
  rawAppId: number,
  scopeType: FileScopeType,
  scopeValue: string,
): boolean {
  const appId = resolveCanonicalAppId(rawAppId) ?? rawAppId;
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

// ── Sandbox writable paths (escalation-on-denial) ────────────────────────────
// Absolute OS paths the user granted the command sandbox write access to. Stored
// on the same table under `SANDBOX_PATH_SCOPE`, always `always_allow`, verbatim
// (NOT run through the workspace-relative `normalizeScopeValue`).

/** All sandbox writable paths granted for this workspace (absolute, verbatim). */
export function listSandboxWritablePaths(rawAppId: number): string[] {
  const appId = resolveCanonicalAppId(rawAppId) ?? rawAppId;
  return db
    .select()
    .from(workspaceFilePermissions)
    .where(
      and(
        eq(workspaceFilePermissions.appId, appId),
        eq(workspaceFilePermissions.scopeType, SANDBOX_PATH_SCOPE),
      ),
    )
    .all()
    .map((r) => r.scopeValue);
}

/** Grant the command sandbox write access to `absPath` for this workspace. */
export function upsertSandboxWritablePath(
  rawAppId: number,
  absPath: string,
): void {
  const appId = resolveCanonicalAppId(rawAppId) ?? rawAppId;
  const value = absPath.trim();
  if (!value) return;

  const existing = db
    .select()
    .from(workspaceFilePermissions)
    .where(
      and(
        eq(workspaceFilePermissions.appId, appId),
        eq(workspaceFilePermissions.scopeType, SANDBOX_PATH_SCOPE),
        eq(workspaceFilePermissions.scopeValue, value),
      ),
    )
    .get();
  if (existing) return; // idempotent — already granted

  db.insert(workspaceFilePermissions)
    .values({
      appId,
      scopeType: SANDBOX_PATH_SCOPE,
      scopeValue: value,
      decision: "always_allow",
    })
    .run();
}

/** Revoke a previously granted sandbox writable path. */
export function revokeSandboxWritablePath(
  rawAppId: number,
  absPath: string,
): boolean {
  const appId = resolveCanonicalAppId(rawAppId) ?? rawAppId;
  const value = absPath.trim();
  if (!value) return false;
  const result = db
    .delete(workspaceFilePermissions)
    .where(
      and(
        eq(workspaceFilePermissions.appId, appId),
        eq(workspaceFilePermissions.scopeType, SANDBOX_PATH_SCOPE),
        eq(workspaceFilePermissions.scopeValue, value),
      ),
    )
    .run();
  return result.changes > 0;
}
