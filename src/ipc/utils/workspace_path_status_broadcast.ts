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

export async function computeAllWorkspacePathStatuses(): Promise<AppPathStatus[]> {
  const rows = await db.select({ id: apps.id, path: apps.path }).from(apps);
  return rows.map((a) => {
    const pathExists = fs.existsSync(getAtlarixAppPath(a.path));
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
