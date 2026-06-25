import fs from "node:fs";
import { db } from "../../db";
import { apps } from "../../db/schema";
import { getAtlarixAppPath } from "../../paths/paths";
import { broadcastToAllWindows } from "./broadcast_all_windows";

export type WorkspaceStatus = "active" | "missing";

export interface AppPathStatus {
  id: number;
  pathExists: boolean;
  status: WorkspaceStatus;
}

let lastBroadcastJson = "";

/**
 * Statting a workspace path can pop a folder-access prompt on macOS when the
 * path sits under a protected directory (~/Documents, ~/Desktop, …). This was
 * done on EVERY `browser-window-focus` (and in `list-apps`), so the prompt
 * recurred constantly. Cache existence per workspace id for the session so each
 * path is stat'd at most once; the focus refresh and the app list both read
 * through here. Platform-neutral — no OS branching, just fewer redundant stats.
 *
 * A new workspace gets a fresh id → cache miss → it is stat'd once; removed
 * workspaces simply stop appearing in the query, so their stale entries are
 * inert. An existing workspace's folder appearing/disappearing on disk is no
 * longer noticed on focus (still caught when the workspace is actually opened);
 * call `invalidateWorkspacePathStatusCache()` to force a re-check.
 */
const pathExistsCache = new Map<number, boolean>();

/** Remote workspaces have no local path to stat. */
function pathExistsFor(path: string): boolean {
  if (path?.startsWith("atlarix-remote://")) return true;
  return fs.existsSync(getAtlarixAppPath(path));
}

/** Drop the cached statuses so the next read re-stats every workspace path. */
export function invalidateWorkspacePathStatusCache(): void {
  pathExistsCache.clear();
}

/** Existence for one workspace, served from the session cache (stats on miss). */
export function workspacePathExists(id: number, path: string): boolean {
  const cached = pathExistsCache.get(id);
  if (cached !== undefined) return cached;
  const exists = pathExistsFor(path);
  pathExistsCache.set(id, exists);
  return exists;
}

export async function computeAllWorkspacePathStatuses(): Promise<
  AppPathStatus[]
> {
  const rows = await db.select({ id: apps.id, path: apps.path }).from(apps);
  return rows.map((a) => {
    const pathExists = workspacePathExists(a.id, a.path);
    return {
      id: a.id,
      pathExists,
      status: pathExists ? ("active" as const) : ("missing" as const),
    };
  });
}

/** Re-check all workspace paths and notify renderers if anything changed. */
export async function broadcastWorkspacePathStatusesIfChanged(): Promise<void> {
  const statuses = await computeAllWorkspacePathStatuses();
  const json = JSON.stringify(statuses);
  if (json === lastBroadcastJson) return;
  lastBroadcastJson = json;
  broadcastToAllWindows("apps:status-changed", { statuses });
}
