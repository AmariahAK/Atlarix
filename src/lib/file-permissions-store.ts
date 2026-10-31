/**
 * Workspace-scoped file path permissions (SQLite).
 */

import { and, eq, isNull, ne, or } from "drizzle-orm";
import { db, getDb } from "@/db";
import { workspaceFilePermissions } from "@/db/schema";
import type {
  FilePermissionDecision,
  FileScopeType,
} from "@/lib/file-permission-scope";
import { normalizeRelativePath, normalizeScopeValue } from "@/lib/file-permission-scope";
import {
  resolveFileRepoContext,
  toRepoRelativePath,
  toWorkspaceRelativePath,
  type FileRepoContext,
} from "@/lib/file-permission-repo";
import { resolveCanonicalAppId } from "@/ipc/utils/canonical-app";

/**
 * Reused scope value for sandbox writable-path grants (escalation-on-denial).
 * Rows with this scopeType store an ABSOLUTE OS path verbatim (no relative
 * normalization) and are consumed only by the command sandbox — the file-write
 * gate filters them out (see `listWorkspaceFilePermissions`).
 */
const SANDBOX_PATH_SCOPE = "sandbox_path" as const;

/** Scope types that carry a workspace-relative path (shared across worktrees). */
const PATH_SCOPES: ReadonlySet<FileScopeType> = new Set([
  "file",
  "directory",
  "folder",
]);

function workspacePathForApp(appId: number): string | null {
  try {
    const row = getDb().$client
      .prepare("SELECT path FROM apps WHERE id = ?")
      .get(appId) as { path?: string } | undefined;
    return row?.path ?? null;
  } catch {
    return null;
  }
}

/** The repo identity (and workspace path) a permission write/read resolves against. */
function repoScopeForApp(rawAppId: number): {
  appId: number;
  ctx: FileRepoContext | null;
  workspacePath: string | null;
} {
  const appId = resolveCanonicalAppId(rawAppId) ?? rawAppId;
  const workspacePath = workspacePathForApp(appId);
  const ctx = workspacePath ? resolveFileRepoContext(workspacePath) : null;
  return { appId, ctx, workspacePath };
}

/**
 * A workspace-relative path re-expressed relative to the repo root (the
 * coordinate the store persists path scopes in), or unchanged when the workspace
 * is not a git checkout. Used by the approval handler and the preflight, whose
 * inputs are workspace-relative.
 */
export function toRepoRelativePathForApp(
  appId: number,
  workspaceRelative: string,
): string {
  const normalized = normalizeRelativePath(workspaceRelative);
  if (!normalized) return "";
  const { ctx, workspacePath } = repoScopeForApp(appId);
  if (!workspacePath) return normalized;
  if (ctx) return toRepoRelativePath(ctx, workspacePath, normalized);
  // Not a git checkout: re-express against the workspace root so an ABSOLUTE
  // path (what the model passes right after read_file) matches the same file
  // asked relative on a later turn (0o). Without this the two spellings saved
  // two different rules and every "from now on" grant failed to stick.
  return toWorkspaceRelativePath(workspacePath, normalized);
}

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
  const { appId: canonical, ctx } = repoScopeForApp(appId);
  // In a git repo: the repo-shared rules (any worktree of this repo) plus this
  // workspace's own legacy (pre-sharing) rules. Outside a repo: this workspace's.
  const where = ctx
    ? and(
        ne(workspaceFilePermissions.scopeType, SANDBOX_PATH_SCOPE),
        or(
          eq(workspaceFilePermissions.repoKey, ctx.repoKey),
          and(
            eq(workspaceFilePermissions.appId, canonical),
            isNull(workspaceFilePermissions.repoKey),
          ),
        ),
      )
    : and(
        eq(workspaceFilePermissions.appId, canonical),
        // Exclude sandbox_path rows — the file-write gate must never see them.
        ne(workspaceFilePermissions.scopeType, SANDBOX_PATH_SCOPE),
      );
  const rows = db.select().from(workspaceFilePermissions).where(where).all();
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
  const { appId, ctx } = repoScopeForApp(rawAppId);
  const normalized = normalizeScopeValue(scopeType, scopeValue);
  if (!normalized) return;

  // Path scopes in a git repo are keyed by the repo (so one approval covers every
  // worktree, 0g) and stored RELATIVE TO THE REPO ROOT — the caller hands the
  // scope value in that coordinate space. Extension rules stay per-workspace.
  const repoKey =
    ctx && PATH_SCOPES.has(scopeType) ? ctx.repoKey : null;
  const stored = normalized;

  if (repoKey) {
    // A shared rule already saved by any worktree of this repo: update in place.
    const shared = db
      .select()
      .from(workspaceFilePermissions)
      .where(
        and(
          eq(workspaceFilePermissions.repoKey, repoKey),
          eq(workspaceFilePermissions.scopeType, scopeType),
          eq(workspaceFilePermissions.scopeValue, stored),
        ),
      )
      .get();
    if (shared) {
      db.update(workspaceFilePermissions)
        .set({ decision })
        .where(eq(workspaceFilePermissions.id, shared.id))
        .run();
      return;
    }
    // A legacy rule for THIS workspace (saved before sharing existed): convert
    // it rather than insert a row that would clash with the (appId, scope) index.
    const legacy = db
      .select()
      .from(workspaceFilePermissions)
      .where(
        and(
          eq(workspaceFilePermissions.appId, appId),
          eq(workspaceFilePermissions.scopeType, scopeType),
          eq(workspaceFilePermissions.scopeValue, stored),
          isNull(workspaceFilePermissions.repoKey),
        ),
      )
      .get();
    if (legacy) {
      db.update(workspaceFilePermissions)
        .set({ decision, repoKey })
        .where(eq(workspaceFilePermissions.id, legacy.id))
        .run();
      return;
    }
    db.insert(workspaceFilePermissions)
      .values({ appId, repoKey, scopeType, scopeValue: stored, decision })
      .run();
    return;
  }

  // Non-git workspace (or extension scope): keyed by workspace, as before.
  const existing = db
    .select()
    .from(workspaceFilePermissions)
    .where(
      and(
        eq(workspaceFilePermissions.appId, appId),
        eq(workspaceFilePermissions.scopeType, scopeType),
        eq(workspaceFilePermissions.scopeValue, stored),
        isNull(workspaceFilePermissions.repoKey),
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
    .values({ appId, repoKey, scopeType, scopeValue: stored, decision })
    .run();
}

export function revokeWorkspaceFilePermission(
  rawAppId: number,
  scopeType: FileScopeType,
  scopeValue: string,
): boolean {
  const { appId, ctx } = repoScopeForApp(rawAppId);
  const normalized = normalizeScopeValue(scopeType, scopeValue);
  if (!normalized) return false;

  const repoKey =
    ctx && PATH_SCOPES.has(scopeType) ? ctx.repoKey : null;
  const stored = normalized;

  if (repoKey) {
    const shared = db
      .delete(workspaceFilePermissions)
      .where(
        and(
          eq(workspaceFilePermissions.repoKey, repoKey),
          eq(workspaceFilePermissions.scopeType, scopeType),
          eq(workspaceFilePermissions.scopeValue, stored),
        ),
      )
      .run();
    if (shared.changes > 0) return true;
  }

  const result = db
    .delete(workspaceFilePermissions)
    .where(
      and(
        eq(workspaceFilePermissions.appId, appId),
        eq(workspaceFilePermissions.scopeType, scopeType),
        eq(workspaceFilePermissions.scopeValue, stored),
        isNull(workspaceFilePermissions.repoKey),
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
