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
 * recurred constantly. Cache existence per workspace id so a path that EXISTS is
 * stat'd at most once per session; the focus refresh and the app list both read
 * through here. Platform-neutral — no OS branching, just fewer redundant stats.
 *
 * ONLY the positive result is cached. A `false` is re-checked on every read,
 * because "missing" is a recoverable state and caching it was a trap: deleting a
 * repo and re-cloning it to the same path left the workspace stuck on
 * "Folder not found" for the whole session, with no way back but restarting the
 * app. (The previous note here claimed the disappearance was "still caught when
 * the workspace is actually opened" and pointed at
 * `invalidateWorkspacePathStatusCache()` — but nothing in the app ever called
 * that, so neither escape hatch existed.)
 *
 * The prompt-spam fix is unaffected: a workspace whose folder is present stays
 * cached and is never re-stat'd. Re-statting is confined to workspaces the user
 * is already being shown as broken — precisely where a fresh check is wanted.
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

/**
 * Drop ONE workspace's cached status.
 *
 * Only a cached `true` is sticky (a `false` re-stats anyway), so this exists for
 * the opposite direction: a folder that was present at first stat and has since
 * been deleted or moved. Call it when the user actually engages that workspace —
 * one stat, at a moment they are expecting the app to touch the folder — rather
 * than on window focus, which is what made the macOS prompt recur.
 */
export function invalidateWorkspacePathStatus(id: number): void {
  pathExistsCache.delete(id);
}

/**
 * Existence for one workspace. A cached `true` is trusted for the session (that
 * is the prompt-spam guarantee); anything else is stat'd, so a folder that comes
 * back — a re-clone, a remounted drive, a rename undone — recovers on its own.
 */
export function workspacePathExists(id: number, path: string): boolean {
  if (pathExistsCache.get(id) === true) return true;
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
